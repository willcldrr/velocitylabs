/**
 * Simple iCal parser for Turo calendar feeds
 * Parses ICS files and extracts booking events
 */

import { safeFetch } from "./safe-fetch"

export interface ICalEvent {
  uid: string
  summary: string
  dtstart: Date
  dtend: Date
  description?: string
}

/**
 * Parse iCal date string to JavaScript Date
 * Handles both DATE and DATE-TIME formats
 */
function parseICalDate(dateStr: string): Date {
  // Remove any VALUE=DATE: prefix
  const cleanDate = dateStr.replace(/^VALUE=DATE:/i, '').replace(/^TZID=[^:]+:/i, '')

  // DATE format: YYYYMMDD
  if (cleanDate.length === 8) {
    const year = parseInt(cleanDate.substring(0, 4))
    const month = parseInt(cleanDate.substring(4, 6)) - 1 // JS months are 0-indexed
    const day = parseInt(cleanDate.substring(6, 8))
    return new Date(year, month, day)
  }

  // DATE-TIME format: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  if (cleanDate.includes('T')) {
    const [datePart, timePart] = cleanDate.split('T')
    const year = parseInt(datePart.substring(0, 4))
    const month = parseInt(datePart.substring(4, 6)) - 1
    const day = parseInt(datePart.substring(6, 8))

    const isUtc = timePart.endsWith('Z')
    const timeClean = timePart.replace('Z', '')
    const hour = parseInt(timeClean.substring(0, 2))
    const minute = parseInt(timeClean.substring(2, 4))
    const second = parseInt(timeClean.substring(4, 6) || '0')

    if (isUtc) {
      return new Date(Date.UTC(year, month, day, hour, minute, second))
    }
    return new Date(year, month, day, hour, minute, second)
  }

  // Fallback
  return new Date(cleanDate)
}

/**
 * Unfold iCal content (lines can be split with CRLF + whitespace)
 */
function unfoldIcal(content: string): string {
  return content.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
}

/**
 * Parse an ICS string and extract events
 */
export function parseIcal(icsContent: string): ICalEvent[] {
  const events: ICalEvent[] = []
  const unfolded = unfoldIcal(icsContent)
  const lines = unfolded.split(/\r?\n/)

  let currentEvent: Partial<ICalEvent> | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === 'BEGIN:VEVENT') {
      currentEvent = {}
      continue
    }

    if (trimmed === 'END:VEVENT') {
      if (currentEvent && currentEvent.uid && currentEvent.dtstart && currentEvent.dtend) {
        events.push({
          uid: currentEvent.uid,
          summary: currentEvent.summary || 'Blocked',
          dtstart: currentEvent.dtstart,
          dtend: currentEvent.dtend,
          description: currentEvent.description,
        })
      }
      currentEvent = null
      continue
    }

    if (!currentEvent) continue

    // Parse property
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) continue

    const propertyPart = trimmed.substring(0, colonIndex)
    const valuePart = trimmed.substring(colonIndex + 1)

    // Handle properties with parameters (e.g., DTSTART;VALUE=DATE:20260315)
    const propertyName = propertyPart.split(';')[0].toUpperCase()

    switch (propertyName) {
      case 'UID':
        currentEvent.uid = valuePart
        break
      case 'SUMMARY':
        currentEvent.summary = valuePart
        break
      case 'DTSTART':
        currentEvent.dtstart = parseICalDate(valuePart)
        break
      case 'DTEND':
        currentEvent.dtend = parseICalDate(valuePart)
        break
      case 'DESCRIPTION':
        currentEvent.description = valuePart.replace(/\\n/g, '\n').replace(/\\,/g, ',')
        break
    }
  }

  return events
}

/**
 * Fetch and parse iCal from URL
 */
export async function fetchAndParseIcal(url: string): Promise<ICalEvent[]> {
  // LB-9 / Security H2: `url` is `vehicles.turo_ical_url`, which is
  // user-controlled. Use the HARDENED safeFetch (NOT safeFetchAllowInternal)
  // to block SSRF into cloud metadata, internal admin hosts, loopback, etc.
  const response = await safeFetch(url, {
    headers: {
      'User-Agent': 'RentalCapture/1.0 Calendar Sync',
    },
    timeoutMs: 15_000,
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch iCal: ${response.status} ${response.statusText}`)
  }

  const icsContent = await response.text()
  return parseIcal(icsContent)
}

/**
 * Filter events to only include future and recent past events
 */
export function filterRelevantEvents(events: ICalEvent[], daysBack = 7, daysAhead = 365): ICalEvent[] {
  const now = new Date()
  const pastCutoff = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
  const futureCutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

  return events.filter(event =>
    event.dtend >= pastCutoff && event.dtstart <= futureCutoff
  )
}
