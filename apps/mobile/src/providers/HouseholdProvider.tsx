import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Household } from "@localclear/domain";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { api } from "../lib/api";
import { useAuth } from "./AuthProvider";

const ACTIVE_HOUSEHOLD_KEY = "localclear.active-household";

interface HouseholdContextValue {
  households: Household[];
  activeHousehold: Household | null;
  loading: boolean;
  error: string | null;
  setActiveHousehold(id: string): Promise<void>;
  refresh(): Promise<void>;
}

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

export function HouseholdProvider({ children }: PropsWithChildren) {
  const { user } = useAuth();
  const [households, setHouseholds] = useState<Household[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setHouseholds([]);
      setActiveId(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [{ households: next }, savedId] = await Promise.all([
        api.listHouseholds(),
        AsyncStorage.getItem(ACTIVE_HOUSEHOLD_KEY),
      ]);
      setHouseholds(next);
      const selected = next.some((household) => household.id === savedId)
        ? savedId
        : (next[0]?.id ?? null);
      setActiveId(selected);
      if (selected) await AsyncStorage.setItem(ACTIVE_HOUSEHOLD_KEY, selected);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load household",
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setActiveHousehold = useCallback(
    async (id: string) => {
      if (!households.some((household) => household.id === id)) {
        throw new Error("Household is unavailable");
      }
      setActiveId(id);
      await AsyncStorage.setItem(ACTIVE_HOUSEHOLD_KEY, id);
    },
    [households],
  );

  const value = useMemo<HouseholdContextValue>(
    () => ({
      households,
      activeHousehold:
        households.find((household) => household.id === activeId) ?? null,
      loading,
      error,
      setActiveHousehold,
      refresh,
    }),
    [activeId, error, households, loading, refresh, setActiveHousehold],
  );
  return (
    <HouseholdContext.Provider value={value}>
      {children}
    </HouseholdContext.Provider>
  );
}

export function useHousehold(): HouseholdContextValue {
  const value = useContext(HouseholdContext);
  if (!value)
    throw new Error("useHousehold must be used inside HouseholdProvider");
  return value;
}
