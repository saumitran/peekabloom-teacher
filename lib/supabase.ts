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
  first_name: string;
  last_name: string;
}

export interface Observation {
  id: string;
  child_id: string;
  classroom_id: string;
  observation_text: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}
