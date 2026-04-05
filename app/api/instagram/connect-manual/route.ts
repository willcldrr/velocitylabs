import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { encrypt } from "@/lib/crypto"
import { safeFetch } from "@/lib/safe-fetch"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    // Verify authenticated user via Supabase auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = getSupabase()
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { accessToken } = body

    if (!accessToken || typeof accessToken !== "string" || accessToken.length < 20) {
      return NextResponse.json({ error: "Invalid access token" }, { status: 400 })
    }

    // Step 1: Exchange for long-lived token
    let longLivedToken = accessToken
    let expiresIn = 5184000 // 60 days default

    if (process.env.META_APP_ID && process.env.META_APP_SECRET) {
      try {
        const exchangeRes = await safeFetch(
          `https://graph.facebook.com/v19.0/oauth/access_token?` +
          new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            fb_exchange_token: accessToken,
          }).toString(),
          { timeoutMs: 30_000 }
        )

        if (exchangeRes.ok) {
          const tokenData = await exchangeRes.json()
          longLivedToken = tokenData.access_token || accessToken
          expiresIn = tokenData.expires_in || 5184000
        }
      } catch {
        // If exchange fails, proceed with the original token
      }
    }

    // Step 2: Detect token type and find Instagram Business Account
    // Try as User token first (me/accounts), fall back to Page token (me?fields=instagram_business_account)
    let instagramAccountId: string | null = null
    let pageName: string | null = null
    let pageAccessToken: string | null = null

    const pagesRes = await safeFetch(
      `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account,access_token&access_token=${longLivedToken}`
    )

    if (pagesRes.ok) {
      // User token — get pages list
      const pagesData = await pagesRes.json()
      const pages = pagesData.data || []
      console.log("[IG Connect] User token — found", pages.length, "pages:", JSON.stringify(pages.map((p: any) => ({ id: p.id, name: p.name, ig: p.instagram_business_account?.id }))))

      for (const page of pages) {
        if (page.instagram_business_account?.id) {
          instagramAccountId = page.instagram_business_account.id
          pageName = page.name
          pageAccessToken = page.access_token || null
          break
        }
      }

      // If pages found but none have Instagram linked, try each page individually
      if (!instagramAccountId && pages.length > 0) {
        for (const page of pages) {
          const pt = page.access_token || longLivedToken
          try {
            const pageIgRes = await safeFetch(
              `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account{id,username}&access_token=${pt}`
            )
            if (pageIgRes.ok) {
              const pageIgData = await pageIgRes.json()
              console.log("[IG Connect] Page", page.id, "IG check:", JSON.stringify(pageIgData))
              if (pageIgData.instagram_business_account?.id) {
                instagramAccountId = pageIgData.instagram_business_account.id
                pageName = page.name
                pageAccessToken = pt
                break
              }
            }
          } catch { /* skip */ }
        }
      }
    } else {
      // Likely a Page token — try to get Instagram account directly
      const pagesErrBody = await pagesRes.json()
      console.log("[IG Connect] me/accounts failed:", JSON.stringify(pagesErrBody))

      const pageInfoRes = await safeFetch(
        `https://graph.facebook.com/v19.0/me?fields=id,name,instagram_business_account&access_token=${longLivedToken}`
      )

      if (!pageInfoRes.ok) {
        const err = await pageInfoRes.json()
        console.log("[IG Connect] me?fields also failed:", JSON.stringify(err))
        return NextResponse.json(
          { error: err.error?.message || "Invalid token — could not verify" },
          { status: 400 }
        )
      }

      const pageInfo = await pageInfoRes.json()
      console.log("[IG Connect] Page token — me returned:", JSON.stringify(pageInfo))

      if (pageInfo.instagram_business_account?.id) {
        instagramAccountId = pageInfo.instagram_business_account.id
        pageName = pageInfo.name || null
        pageAccessToken = longLivedToken
      }
    }

    if (!instagramAccountId) {
      return NextResponse.json(
        {
          error: "No Instagram Business account found",
          hint: "Make sure your Instagram account is a Business or Creator account linked to a Facebook Page.",
        },
        { status: 400 }
      )
    }

    // Step 3: Get Instagram username
    const tokenForIG = pageAccessToken || longLivedToken
    let instagramUsername: string | null = null

    try {
      const igRes = await safeFetch(
        `https://graph.facebook.com/v19.0/${instagramAccountId}?fields=username&access_token=${tokenForIG}`
      )
      if (igRes.ok) {
        const igData = await igRes.json()
        instagramUsername = igData.username || null
      }
    } catch {
      // Non-critical
    }

    // Step 4: Determine the best token to store
    let finalToken = pageAccessToken || longLivedToken
    let finalExpiry = new Date(Date.now() + expiresIn * 1000)

    if (pageAccessToken && process.env.META_APP_ID && process.env.META_APP_SECRET) {
      try {
        const pageExchangeRes = await safeFetch(
          `https://graph.facebook.com/v19.0/oauth/access_token?` +
          new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            fb_exchange_token: pageAccessToken,
          }).toString(),
          { timeoutMs: 30_000 }
        )
        if (pageExchangeRes.ok) {
          const pageTokenData = await pageExchangeRes.json()
          finalToken = pageTokenData.access_token || finalToken
          finalExpiry = new Date(Date.now() + (pageTokenData.expires_in || 5184000) * 1000)
        }
      } catch {
        // Use the original page token
      }
    }

    // Step 5: Upsert the connection
    // LB-6 dual-write: encrypt and keep plaintext populated until the
    // drop migration runs.
    // TODO(LB-6 cutover): remove plaintext write after drop migration
    const encToken = encrypt(finalToken)
    const { error: upsertError } = await supabase
      .from("instagram_connections")
      .upsert(
        {
          user_id: user.id,
          instagram_account_id: instagramAccountId,
          instagram_username: instagramUsername,
          page_name: pageName,
          access_token: finalToken,
          encrypted_access_token: encToken.ciphertext,
          access_token_iv: encToken.iv,
          access_token_tag: encToken.tag,
          token_expires_at: finalExpiry.toISOString(),
          connected_at: new Date().toISOString(),
          is_active: true,
        },
        { onConflict: "user_id" }
      )

    if (upsertError) {
      console.error("[Instagram Manual Connect] Upsert error:", upsertError)
      return NextResponse.json({ error: "Failed to save connection" }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      username: instagramUsername,
      pageName,
      instagramAccountId,
      expiresAt: finalExpiry.toISOString(),
    })
  } catch (error) {
    console.error("[Instagram Manual Connect] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
