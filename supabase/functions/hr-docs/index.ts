// Supabase Edge Function entry: hr-docs (deploy with --no-verify-jwt; auth is
// the admin token for admin actions and the private link token for signers).
import { handle } from "./handler.ts";

Deno.serve(handle);
