import { z } from "zod";

const PublicEnvironmentSchema = z.object({
  apiUrl: z.url(),
  supabaseUrl: z.url(),
  supabaseAnonKey: z.string().min(20),
});

export const environment = PublicEnvironmentSchema.parse({
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});
