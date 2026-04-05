import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const serviceSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    // Authenticate the request
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const type = searchParams.get("type") || "bookings"
    const from = searchParams.get("from")
    const to = searchParams.get("to")
    const format = searchParams.get("format") || "json"

    if (!["bookings", "revenue", "leads"].includes(type)) {
      return NextResponse.json({ error: "Invalid type. Must be bookings, revenue, or leads." }, { status: 400 })
    }

    if (!["json", "csv", "pdf"].includes(format)) {
      return NextResponse.json({ error: "Invalid format. Must be json, csv, or pdf." }, { status: 400 })
    }

    let data: Record<string, unknown>[] = []
    let summary: Record<string, unknown> = {}

    if (type === "bookings" || type === "revenue") {
      let query = serviceSupabase
        .from("bookings")
        .select("id, customer_name, vehicle_id, start_date, end_date, status, total_amount, deposit_amount, deposit_paid, stripe_payment_intent, created_at, vehicles(name)")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })

      if (from) query = query.gte("created_at", from)
      if (to) query = query.lte("created_at", `${to}T23:59:59.999Z`)

      const { data: bookings, error } = await query
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      const rows = bookings || []

      if (type === "revenue") {
        // Filter to only confirmed payments
        const confirmed = rows.filter((b) => !!b.stripe_payment_intent)
        const totalRevenue = confirmed.reduce((sum, b) => sum + (Number(b.deposit_amount) || 0), 0)
        const avgBookingValue = confirmed.length > 0 ? totalRevenue / confirmed.length : 0

        data = confirmed.map((b) => ({
          id: b.id,
          customer_name: b.customer_name,
          vehicle: ((b.vehicles as unknown as { name: string } | null))?.name || "N/A",
          start_date: b.start_date,
          end_date: b.end_date,
          deposit_amount: b.deposit_amount,
          total_amount: b.total_amount,
          created_at: b.created_at,
        }))

        summary = {
          total_revenue: totalRevenue,
          total_bookings: confirmed.length,
          avg_booking_value: Math.round(avgBookingValue * 100) / 100,
        }
      } else {
        data = rows.map((b) => ({
          id: b.id,
          customer_name: b.customer_name,
          vehicle: ((b.vehicles as unknown as { name: string } | null))?.name || "N/A",
          start_date: b.start_date,
          end_date: b.end_date,
          status: b.status,
          total_amount: b.total_amount,
          deposit_amount: b.deposit_amount,
          deposit_paid: b.deposit_paid,
          created_at: b.created_at,
        }))

        const confirmed = rows.filter((b) => !!b.stripe_payment_intent)
        const totalRevenue = confirmed.reduce((sum, b) => sum + (Number(b.deposit_amount) || 0), 0)

        summary = {
          total_bookings: rows.length,
          confirmed_bookings: confirmed.length,
          total_revenue: totalRevenue,
          avg_booking_value: confirmed.length > 0 ? Math.round((totalRevenue / confirmed.length) * 100) / 100 : 0,
        }
      }
    } else if (type === "leads") {
      let query = serviceSupabase
        .from("leads")
        .select("id, name, email, phone, status, source, vehicle_interest, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })

      if (from) query = query.gte("created_at", from)
      if (to) query = query.lte("created_at", `${to}T23:59:59.999Z`)

      const { data: leads, error } = await query
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      const rows = leads || []
      data = rows.map((l) => ({
        id: l.id,
        name: l.name,
        email: l.email,
        phone: l.phone,
        status: l.status,
        source: l.source,
        vehicle_interest: l.vehicle_interest,
        created_at: l.created_at,
      }))

      const bookedLeads = rows.filter((l) => l.status === "booked").length
      const conversionRate = rows.length > 0 ? Math.round((bookedLeads / rows.length) * 100 * 100) / 100 : 0

      summary = {
        total_leads: rows.length,
        booked: bookedLeads,
        conversion_rate: conversionRate,
        by_status: rows.reduce<Record<string, number>>((acc, l) => {
          const status = l.status || "unknown"
          acc[status] = (acc[status] || 0) + 1
          return acc
        }, {}),
      }
    }

    // CSV format
    if (format === "csv") {
      if (data.length === 0) {
        return new NextResponse("No data found for the selected criteria.", {
          status: 200,
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename="${type}_report.csv"`,
          },
        })
      }

      const headers = Object.keys(data[0])
      const csvRows = [
        headers.join(","),
        ...data.map((row) =>
          headers
            .map((h) => {
              const val = row[h]
              if (val === null || val === undefined) return ""
              const str = String(val)
              // Escape CSV values that contain commas, quotes, or newlines
              if (str.includes(",") || str.includes('"') || str.includes("\n")) {
                return `"${str.replace(/"/g, '""')}"`
              }
              return str
            })
            .join(",")
        ),
      ]

      return new NextResponse(csvRows.join("\n"), {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${type}_report.csv"`,
        },
      })
    }

    // PDF format (HTML report for window.print())
    if (format === "pdf") {
      const dateRange = from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Until ${to}` : "All time"
      const reportTitle = type.charAt(0).toUpperCase() + type.slice(1) + " Report"

      const tableHeaders = data.length > 0 ? Object.keys(data[0]) : []
      const tableRows = data.map((row) =>
        tableHeaders.map((h) => {
          const val = row[h]
          if (val === null || val === undefined) return ""
          return String(val)
        })
      )

      const summaryHtml = Object.entries(summary)
        .filter(([, v]) => typeof v !== "object")
        .map(([key, value]) => {
          const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
          const formatted = typeof value === "number" && key.includes("revenue")
            ? `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
            : typeof value === "number" && key.includes("rate")
            ? `${value}%`
            : typeof value === "number" && key.includes("value")
            ? `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
            : String(value)
          return `<div style="background:#111;border:1px solid #333;border-radius:8px;padding:16px 20px;text-align:center;"><div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${label}</div><div style="font-size:24px;font-weight:700;color:#fff;">${formatted}</div></div>`
        })
        .join("")

      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${reportTitle}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; color: #fff; padding: 40px; }
    .header { margin-bottom: 32px; border-bottom: 1px solid #333; padding-bottom: 24px; }
    .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    .header p { font-size: 14px; color: #999; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; background: #111; border-bottom: 2px solid #333; color: #999; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    td { padding: 10px 12px; border-bottom: 1px solid #222; }
    tr:hover td { background: #111; }
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #333; font-size: 12px; color: #666; }
    @media print {
      body { background: #fff; color: #000; padding: 20px; }
      .header { border-bottom-color: #ddd; }
      .header p { color: #666; }
      .summary-grid div { background: #f5f5f5 !important; border-color: #ddd !important; }
      .summary-grid div div:first-child { color: #666 !important; }
      .summary-grid div div:last-child { color: #000 !important; }
      th { background: #f5f5f5; border-bottom-color: #ddd; color: #666; }
      td { border-bottom-color: #eee; }
      tr:hover td { background: #f9f9f9; }
      .footer { border-top-color: #ddd; color: #999; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:20px;">
    <button onclick="window.print()" style="background:#fff;color:#000;border:none;padding:10px 24px;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px;">Print / Save as PDF</button>
  </div>
  <div class="header">
    <h1>${reportTitle}</h1>
    <p>Date Range: ${dateRange} &bull; Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
  </div>
  <div class="summary-grid">${summaryHtml}</div>
  <table>
    <thead><tr>${tableHeaders.map((h) => `<th>${h.replace(/_/g, " ")}</th>`).join("")}</tr></thead>
    <tbody>${tableRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>
  <div class="footer">Velocity Labs Analytics Report &bull; ${data.length} records</div>
</body>
</html>`

      return new NextResponse(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    }

    // JSON format (default)
    return NextResponse.json({ data, summary })
  } catch (error) {
    log.error("[Analytics API] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
