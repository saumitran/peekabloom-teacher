# Peekabloom Teacher App

## Overview
Expo React Native iPad app for daycare teachers to record voice observations about children. Optimized for iPad landscape with a dark theme designed for bright classroom environments.

## Architecture
- **Frontend**: Expo Router (file-based routing) with React Native
- **Backend**: Express server on port 5000 (landing page + API proxy)
- **Database**: Supabase (external) for classrooms, children, and observations
- **State**: React Context for classroom session, SecureStore for device persistence

## Screens
- `/` — Activation screen: enter classroom code to look up in Supabase
- `/home` — Main teaching screen: children grid + recording bar (Voice/Photo tabs)
- `/review` — Review pending observations: inline edit, delete, approve all

## Key Libraries
- `@supabase/supabase-js` — Supabase client for data access
- `expo-secure-store` — Persist classroom ID on device
- `@expo-google-fonts/nunito` — Brand font (Nunito)
- `expo-haptics` — Tactile feedback on interactions
- `react-native-reanimated` — Entry animations

## Brand Colors
- Background: `#1A1A2E` (deep navy)
- Surface: `#2D2D44` (elevated cards)
- Primary: `#F97B6B` (coral)
- Accent: `#7BC4A0` (sage green)
- Text: `#FFFFFF` / Muted: `#A0A0B8`

## Environment Variables (Secrets)
- `EXPO_PUBLIC_SUPABASE_URL` — Supabase project URL
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key
- `EXPO_PUBLIC_PARSING_API_URL` — Parsing API endpoint
- `EXPO_PUBLIC_PARSING_API_KEY` — Parsing API bearer token

## Supabase Tables Expected
- `classrooms` — id, name, activation_code
- `children` — id, classroom_id, first_name, last_name
- `observations` — id, child_id, classroom_id, observation_text, status, created_at

## Workflows
- `Start Backend` — `npm run server:dev` (port 5000)
- `Start Frontend` — `npm run expo:dev` (port 8081)
