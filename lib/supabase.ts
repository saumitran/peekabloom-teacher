import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Classroom {
  id: string;
  name: string;
  activation_code: string;
}

export interface Child {
  id: string;
  classroom_id: string;
  name: string;
  created_at: string;
}

export interface Observation {
  id: string;
  child_id: string;
  classroom_id: string;
  parsed_content: string;
  hdlh_tags: string[];
  elect_tags: string[];
  photo_url: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export interface AttendanceEvent {
  id: string;
  child_id: string;
  classroom_id: string;
  event_type: "checkin" | "checkout" | "nap_start" | "nap_end";
  recorded_at: string;
  date: string;
}
