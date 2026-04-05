import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getGoogleCalendarClient } from "@/lib/crm/google-calendar"
import { applyRateLimit } from "@/lib/api-rate-limit"

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const supabase = await createClient()

  // Check if user is authenticated
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Check if admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .single()

  if (!profile?.is_admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const body = await request.json()
    const {
      title,
      description,
      start_time,
      end_time,
      event_type,
      lead_id,
      location,
      is_all_day,
      sync_to_google,
      create_meet_link,
      attendees,
    } = body

    // Create event in our database first
    const eventData: any = {
      user_id: user.id,
      title,
      description: description || null,
      start_time,
      end_time,
      event_type: event_type || "meeting",
      lead_id: lead_id || null,
      location: location || null,
      is_all_day: is_all_day || false,
      attendees: attendees || [],
    }

    // If Google sync is requested
    let googleEventId = null
    let meetLink = null

    if (sync_to_google) {
      const calendarClient = await getGoogleCalendarClient(user.id)

      if (calendarClient) {
        try {
          // Prepare Google Calendar event
          const googleEvent: any = {
            summary: title,
            description: description || undefined,
            start: is_all_day
              ? { date: start_time.split("T")[0] }
              : { dateTime: start_time, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            end: is_all_day
              ? { date: end_time.split("T")[0] }
              : { dateTime: end_time, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            location: location || undefined,
          }

          // Add attendees if provided
          if (attendees && attendees.length > 0) {
            googleEvent.attendees = attendees.map((email: string) => ({ email }))
          }

          let createdEvent
          if (create_meet_link) {
            createdEvent = await calendarClient.createEventWithMeet("primary", googleEvent, {
              sendUpdates: "all",
            })
          } else {
            createdEvent = await calendarClient.createEvent("primary", googleEvent, {
              sendUpdates: "all",
            })
          }

          googleEventId = createdEvent.id

          // Extract Meet link if created
          if (createdEvent.conferenceData?.entryPoints) {
            const videoEntry = createdEvent.conferenceData.entryPoints.find(
              (ep: any) => ep.entryPointType === "video"
            )
            if (videoEntry) {
              meetLink = videoEntry.uri
            }
          }

          // Also get the hangoutLink as backup
          if (!meetLink && createdEvent.hangoutLink) {
            meetLink = createdEvent.hangoutLink
          }
        } catch (googleError: any) {
          console.error("Google Calendar sync error:", googleError)
          // Continue without Google sync - don't fail the whole request
        }
      }
    }

    // Add Google-specific fields to event data
    if (googleEventId) {
      eventData.google_event_id = googleEventId
      eventData.google_calendar_id = "primary"
    }
    if (meetLink) {
      eventData.meeting_link = meetLink
      eventData.meeting_provider = "google_meet"
    }

    // Insert event into database
    const { data: newEvent, error } = await supabase
      .from("crm_events")
      .insert(eventData)
      .select()
      .single()

    if (error) {
      throw error
    }

    return NextResponse.json({
      event: newEvent,
      google_synced: !!googleEventId,
      meet_link: meetLink,
    })
  } catch (error: any) {
    console.error("Create event error:", error)
    return NextResponse.json(
      { error: error.message || "Failed to create event" },
      { status: 500 }
    )
  }
}
