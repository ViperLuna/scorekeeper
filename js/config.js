// Supabase connection. These two values are PUBLIC by design (the anon key is
// meant to sit in a web page). What protects your data is Row Level Security
// in supabase/schema.sql.
//
// NEVER put the "service_role" key (or your database password) in this repo.
window.SK_CONFIG = {
  url: '',     // e.g. https://abcdxyz.supabase.co
  anonKey: '', // Project Settings -> API -> "anon public"
};
