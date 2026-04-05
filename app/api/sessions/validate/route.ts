import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { applyRateLimit } from '@/lib/api-rate-limit'

// GET - Validate if a session token is still active
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 60, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized', revoked: false }, { status: 401 })
  }

  const sessionToken = request.headers.get('x-session-token')

  if (!sessionToken) {
    return NextResponse.json({ valid: true }) // No token to validate
  }

  // Check if the session token exists for this user
  const { data: session } = await supabase
    .from('user_sessions')
    .select('id')
    .eq('user_id', user.id)
    .eq('session_token', sessionToken)
    .single()

  if (!session) {
    // Session token not found - it was revoked
    return NextResponse.json({ error: 'Session revoked', revoked: true }, { status: 401 })
  }

  return NextResponse.json({ valid: true })
}
