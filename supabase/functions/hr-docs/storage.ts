// Storage seam for the private 'hr-documents' bucket.
// Production: Supabase Storage via the service role (bucket is private, no
// policies, so nothing is reachable by URL). Files are written with
// upsert:false so a stored PDF can never be silently replaced.
// Local dev (HR_DEV=1 + HR_DEV_STORAGE_DIR): plain files on disk.
import { createClient } from "@supabase/supabase-js";

export const BUCKET = "hr-documents";

export interface Store {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array>;
}

class SupabaseStore implements Store {
  private client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  async put(path: string, bytes: Uint8Array) {
    const { error } = await this.client.storage.from(BUCKET).upload(path, bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (error) throw new Error("storage upload failed: " + error.message);
  }
  async get(path: string) {
    const { data, error } = await this.client.storage.from(BUCKET).download(path);
    if (error || !data) throw new Error("storage download failed");
    return new Uint8Array(await data.arrayBuffer());
  }
}

class DiskStore implements Store {
  constructor(private dir: string) {}
  private p(path: string) {
    if (path.includes("..")) throw new Error("bad path");
    return `${this.dir}/${BUCKET}/${path}`;
  }
  async put(path: string, bytes: Uint8Array) {
    const full = this.p(path);
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(full, bytes, { createNew: true }); // never overwrite
  }
  async get(path: string) {
    return await Deno.readFile(this.p(path));
  }
}

export function makeStore(devMode: boolean): Store {
  const dir = Deno.env.get("HR_DEV_STORAGE_DIR");
  if (devMode && dir) return new DiskStore(dir);
  return new SupabaseStore();
}
