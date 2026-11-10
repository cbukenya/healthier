---
entities:
- entity: health-day
  shows:
  - Date
  - Movement
  - Vitals
  - Body
  - Notifications
  - Zones
  - Sources
  - Sleeping heart rate floor
- entity: sleep-session
  shows:
  - Date
  - Kind
  - Timing
  - Duration
  - Stages
  - Efficiency
  - Source
- entity: goals
  shows:
  - Steps
  - Brisk minutes
  - Sleep need
- entity: synchronization
  shows:
  - Progress
  - Last sync
  - Failure
  - Window
  - History
- entity: profile
  shows:
  - Gender
references:
- kind: code
  role: implementation
  target: src/views/TodayView.tsx#TodayView
---

# Today

Today: the body battery and the readings that moved it, last night's sleep, activity so far, overnight vitals, This week, and the insight cards that matter now.
