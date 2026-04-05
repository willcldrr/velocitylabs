import { createClient } from "@/lib/supabase/server"
import { safeFetch } from "@/lib/safe-fetch"
import { log } from "@/lib/log"

interface GoogleCalendarEvent {
  id?: string
  summary: string
  description?: string
  start: {
    dateTime?: string
    date?: string
    timeZone?: string
  }
  end: {
    dateTime?: string
    date?: string
    timeZone?: string
  }
  location?: string
  attendees?: { email: string }[]
  conferenceData?: {
    createRequest?: {
      requestId: string
      conferenceSolutionKey: { type: string }
    }
    entryPoints?: {
      entryPointType: string
      uri: string
      label?: string
    }[]
  }
}

interface TokenData {
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
}

interface OAuthConfig {
  client_id: string
  client_secret: string
}

export class GoogleCalendarClient {
  private accessToken: string
  private refreshToken: string | null
  private tokenExpiresAt: Date | null
  private userId: string
  private config: OAuthConfig | null = null

  constructor(
    userId: string,
    tokenData: TokenData,
    config?: OAuthConfig
  ) {
    this.userId = userId
    this.accessToken = tokenData.access_token
    this.refreshToken = tokenData.refresh_token
    this.tokenExpiresAt = tokenData.token_expires_at
      ? new Date(tokenData.token_expires_at)
      : null
    this.config = config || null
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken || !this.config) {
      return false
    }

    try {
      const response = await safeFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.config.client_id,
          client_secret: this.config.client_secret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
        }),
        timeoutMs: 30_000,
      })

      if (!response.ok) {
        return false
      }

      const tokens = await response.json()
      this.accessToken = tokens.access_token
      this.tokenExpiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null

      // Update tokens in database
      const supabase = await createClient()
      await supabase
        .from("crm_oauth_tokens")
        .update({
          access_token: this.accessToken,
          token_expires_at: this.tokenExpiresAt?.toISOString(),
        })
        .eq("user_id", this.userId)
        .eq("provider", "google")

      return true
    } catch (error) {
      log.error("Failed to refresh token:", error)
      return false
    }
  }

  private async ensureValidToken(): Promise<boolean> {
    // Check if token is expired or about to expire (within 5 minutes)
    if (this.tokenExpiresAt) {
      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000)
      if (this.tokenExpiresAt < fiveMinutesFromNow) {
        return await this.refreshAccessToken()
      }
    }
    return true
  }

  private async makeRequest(
    endpoint: string,
    method: string = "GET",
    body?: any
  ): Promise<any> {
    await this.ensureValidToken()

    const url = `https://www.googleapis.com/calendar/v3${endpoint}`
    const options: RequestInit & { timeoutMs?: number } = {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    }

    if (body) {
      options.body = JSON.stringify(body)
    }

    const response = await safeFetch(url, options)

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error?.message || `API request failed: ${response.status}`)
    }

    // Handle empty responses
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  /**
   * List calendars accessible by the user
   */
  async listCalendars() {
    return this.makeRequest("/users/me/calendarList")
  }

  /**
   * List events from a calendar
   */
  async listEvents(
    calendarId: string = "primary",
    options: {
      timeMin?: string
      timeMax?: string
      maxResults?: number
      singleEvents?: boolean
      orderBy?: "startTime" | "updated"
    } = {}
  ) {
    const params = new URLSearchParams()
    if (options.timeMin) params.set("timeMin", options.timeMin)
    if (options.timeMax) params.set("timeMax", options.timeMax)
    if (options.maxResults) params.set("maxResults", options.maxResults.toString())
    if (options.singleEvents) params.set("singleEvents", "true")
    if (options.orderBy) params.set("orderBy", options.orderBy)

    const queryString = params.toString()
    const endpoint = `/calendars/${encodeURIComponent(calendarId)}/events${queryString ? `?${queryString}` : ""}`

    return this.makeRequest(endpoint)
  }

  /**
   * Get a specific event
   */
  async getEvent(calendarId: string = "primary", eventId: string) {
    return this.makeRequest(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
  }

  /**
   * Create a new event
   */
  async createEvent(
    calendarId: string = "primary",
    event: GoogleCalendarEvent,
    options: {
      sendUpdates?: "all" | "externalOnly" | "none"
      conferenceDataVersion?: number
    } = {}
  ) {
    const params = new URLSearchParams()
    if (options.sendUpdates) params.set("sendUpdates", options.sendUpdates)
    if (options.conferenceDataVersion !== undefined) {
      params.set("conferenceDataVersion", options.conferenceDataVersion.toString())
    }

    const queryString = params.toString()
    const endpoint = `/calendars/${encodeURIComponent(calendarId)}/events${queryString ? `?${queryString}` : ""}`

    return this.makeRequest(endpoint, "POST", event)
  }

  /**
   * Create an event with Google Meet
   */
  async createEventWithMeet(
    calendarId: string = "primary",
    event: Omit<GoogleCalendarEvent, "conferenceData">,
    options: {
      sendUpdates?: "all" | "externalOnly" | "none"
    } = {}
  ) {
    const eventWithConference: GoogleCalendarEvent = {
      ...event,
      conferenceData: {
        createRequest: {
          requestId: `crm-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }

    return this.createEvent(calendarId, eventWithConference, {
      ...options,
      conferenceDataVersion: 1,
    })
  }

  /**
   * Update an existing event
   */
  async updateEvent(
    calendarId: string = "primary",
    eventId: string,
    event: Partial<GoogleCalendarEvent>,
    options: {
      sendUpdates?: "all" | "externalOnly" | "none"
    } = {}
  ) {
    const params = new URLSearchParams()
    if (options.sendUpdates) params.set("sendUpdates", options.sendUpdates)

    const queryString = params.toString()
    const endpoint = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${queryString ? `?${queryString}` : ""}`

    return this.makeRequest(endpoint, "PATCH", event)
  }

  /**
   * Delete an event
   */
  async deleteEvent(
    calendarId: string = "primary",
    eventId: string,
    options: {
      sendUpdates?: "all" | "externalOnly" | "none"
    } = {}
  ) {
    const params = new URLSearchParams()
    if (options.sendUpdates) params.set("sendUpdates", options.sendUpdates)

    const queryString = params.toString()
    const endpoint = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${queryString ? `?${queryString}` : ""}`

    return this.makeRequest(endpoint, "DELETE")
  }
}

/**
 * Get a Google Calendar client for a user
 */
export async function getGoogleCalendarClient(
  userId: string
): Promise<GoogleCalendarClient | null> {
  const supabase = await createClient()

  // Get user's OAuth token
  const { data: token, error: tokenError } = await supabase
    .from("crm_oauth_tokens")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "google")
    .single()

  if (tokenError || !token) {
    return null
  }

  // Get OAuth config for refresh token functionality
  const { data: config } = await supabase
    .from("crm_oauth_config")
    .select("client_id, client_secret")
    .eq("provider", "google")
    .single()

  return new GoogleCalendarClient(
    userId,
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_expires_at: token.token_expires_at,
    },
    config || undefined
  )
}
