import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const bulkBookingSchema = z.object({
  action: z.enum(["update_status", "delete"]),
  bookingIds: z
    .array(z.string().uuid("Invalid booking ID"))
    .min(1, "At least one booking ID is required"),
  status: z
    .enum(["pending", "confirmed", "completed", "cancelled"])
    .optional(),
}).refine(
  (data) => data.action !== "update_status" || data.status !== undefined,
  { message: "Status is required for update_status action", path: ["status"] }
)

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    // Authenticate using Supabase auth
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const body = await request.json()

    const parseResult = bulkBookingSchema.safeParse(body)
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { action, bookingIds, status } = parseResult.data

    let successCount = 0
    let failureCount = 0

    if (action === "update_status" && status) {
      // Bulk status update
      const { data, error } = await supabase
        .from("bookings")
        .update({ status })
        .in("id", bookingIds)
        .eq("user_id", user.id)
        .select("id")

      if (error) {
        log.error("Bulk status update error:", error)
        failureCount = bookingIds.length
      } else {
        successCount = data?.length ?? 0
        failureCount = bookingIds.length - successCount
      }
    } else if (action === "delete") {
      // Soft delete by setting status to "cancelled"
      const { data, error } = await supabase
        .from("bookings")
        .update({ status: "cancelled" })
        .in("id", bookingIds)
        .eq("user_id", user.id)
        .select("id")

      if (error) {
        log.error("Bulk delete error:", error)
        failureCount = bookingIds.length
      } else {
        successCount = data?.length ?? 0
        failureCount = bookingIds.length - successCount
      }
    }

    return NextResponse.json({
      success: true,
      total: bookingIds.length,
      successCount,
      failureCount,
    })
  } catch (error: any) {
    log.error("Bulk booking action error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to perform bulk action" },
      { status: 500 }
    )
  }
}
