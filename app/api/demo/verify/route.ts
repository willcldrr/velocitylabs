import { NextRequest, NextResponse } from 'next/server'
import { log } from "@/lib/log"

// Simple in-memory rate limiting
const attempts = new Map<string, { count: number; resetAt: number }>()

function getRateLimitKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown'
  return ip
}

function isRateLimited(key: string): boolean {
  const now = Date.now()
  const entry = attempts.get(key)

  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + 60_000 })
    return false
  }

  entry.count += 1
  if (entry.count > 5) {
    return true
  }

  return false
}

export async function POST(request: NextRequest) {
  const key = getRateLimitKey(request)

  if (isRateLimited(key)) {
    return NextResponse.json(
      { valid: false, error: 'Too many attempts. Please try again later.' },
      { status: 429 }
    )
  }

  try {
    const body = await request.json()
    const { password } = body

    if (typeof password !== 'string') {
      return NextResponse.json({ valid: false }, { status: 400 })
    }

    const correctPassword = process.env.DEMO_PASSWORD
    if (!correctPassword) {
      log.error('DEMO_PASSWORD environment variable is not set', undefined)
      return NextResponse.json({ valid: false }, { status: 500 })
    }

    const valid = password === correctPassword

    return NextResponse.json({ valid })
  } catch {
    return NextResponse.json({ valid: false }, { status: 400 })
  }
}
