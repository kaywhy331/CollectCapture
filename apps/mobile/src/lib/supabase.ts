import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import "react-native-url-polyfill/auto";
import { environment } from "./environment";

const isServerRendering =
  Platform.OS === "web" && typeof window === "undefined";

const serverStorage = {
  getItem: (_key: string) => null,
  setItem: (_key: string, _value: string) => undefined,
  removeItem: (_key: string) => undefined,
};

export const supabase = createClient(
  environment.supabaseUrl,
  environment.supabaseAnonKey,
  {
    auth: {
      storage: isServerRendering ? serverStorage : AsyncStorage,
      autoRefreshToken: !isServerRendering,
      persistSession: !isServerRendering,
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  },
);
