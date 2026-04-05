import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { applyRateLimit } from '@/lib/api-rate-limit'

function parseUserAgent(ua: string): { device: string; browser: string; os: string } {
  let device = 'Desktop'
  let browser = 'Unknown'
  let os = 'Unknown'

  // Parse OS
  if (ua.includes('iPhone')) os = 'iOS'
  else if (ua.includes('iPad')) os = 'iPadOS'
  else if (ua.includes('Android')) os = 'Android'
  else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS'
  else if (ua.includes('Windows NT 10')) os = 'Windows'
  else if (ua.includes('Windows')) os = 'Windows'
  else if (ua.includes('Linux')) os = 'Linux'
  else if (ua.includes('CrOS')) os = 'Chrome OS'

  // Parse Browser
  if (ua.includes('Edg/')) browser = 'Edge'
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera'
  else if (ua.includes('Chrome/') && !ua.includes('Edg/')) browser = 'Chrome'
  else if (ua.includes('Safari/') && !ua.includes('Chrome/') && !ua.includes('Chromium/')) browser = 'Safari'
  else if (ua.includes('Firefox/')) browser = 'Firefox'

  // Parse Device Type
  if (ua.includes('iPhone') || (ua.includes('Android') && ua.includes('Mobile'))) {
    device = 'Mobile'
  } else if (ua.includes('iPad') || (ua.includes('Android') && !ua.includes('Mobile'))) {
    device = 'Tablet'
  } else {
    device = 'Desktop'
  }

  return { device, browser, os }
}

function getClientIP(request: NextRequest, headersList: Headers): string {
  return (
    headersList.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headersList.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headersList.get('x-real-ip') ||
    headersList.get('cf-connecting-ip') ||
    headersList.get('true-client-ip') ||
    (request as any).ip ||
    'Unknown'
  )
}

// GET - List user's sessions
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get the current device's session_token from the request
  const sessionToken = request.headers.get('x-session-token')

  const { data: sessions, error } = await supabase
    .from('user_sessions')
    .select('*')
    .eq('user_id', user.id)
    .order('last_active', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Mark which session is the current device
  const sessionsWithCurrent = sessions?.map(session => ({
    ...session,
    is_current: session.session_token === sessionToken
  })) || []

  return NextResponse.json({ sessions: sessionsWithCurrent })
}

// POST - Record or update a session for this device
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const headersList = await headers()
  const userAgent = headersList.get('user-agent') || ''
  const ip = getClientIP(request, headersList)
  const { device, browser, os } = parseUserAgent(userAgent)

  // Get session token from request body or header
  let body: { session_token?: string } = {}
  try {
    body = await request.json()
  } catch {
    // No body provided
  }

  const sessionToken = body.session_token || request.headers.get('x-session-token')

  if (!sessionToken) {
    // No token provided - check if there's already a session for this device fingerprint
    const { data: existingDeviceSession } = await supabase
      .from('user_sessions')
      .select('*')
      .eq('user_id', user.id)
      .eq('browser', browser)
      .eq('os', os)
      .eq('ip_address', ip)
      .not('session_token', 'is', null)
      .order('last_active', { ascending: false })
      .limit(1)
      .single()

    if (existingDeviceSession) {
      // Found existing session for this device - update and return its token
      const { data: session, error } = await supabase
        .from('user_sessions')
        .update({
          device_info: device,
          last_active: new Date().toISOString(),
        })
        .eq('id', existingDeviceSession.id)
        .select()
        .single()

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ session, session_token: existingDeviceSession.session_token })
    }

    // No existing session for this device - create new one
    const newToken = crypto.randomUUID()

    const { data: session, error } = await supabase
      .from('user_sessions')
      .insert({
        user_id: user.id,
        session_token: newToken,
        device_info: device,
        browser,
        os,
        ip_address: ip,
        last_active: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ session, session_token: newToken })
  }

  // Check if session with this token exists for this user
  const { data: existingSession } = await supabase
    .from('user_sessions')
    .select('*')
    .eq('user_id', user.id)
    .eq('session_token', sessionToken)
    .single()

  if (existingSession) {
    // Update the existing session
    const { data: session, error } = await supabase
      .from('user_sessions')
      .update({
        device_info: device,
        browser,
        os,
        ip_address: ip,
        last_active: new Date().toISOString(),
      })
      .eq('id', existingSession.id)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ session, session_token: sessionToken })
  }

  // Session token doesn't exist, create new session
  const { data: session, error } = await supabase
    .from('user_sessions')
    .insert({
      user_id: user.id,
      session_token: sessionToken,
      device_info: device,
      browser,
      os,
      ip_address: ip,
      last_active: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ session, session_token: sessionToken })
}

// DELETE - Revoke a session
export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('id')

  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('user_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
