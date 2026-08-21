import { Platform, type TextStyle, type ViewStyle } from "react-native";

export const colors = {
  ink: "#17211B",
  muted: "#5D6B62",
  canvas: "#F7F5EE",
  surface: "#FFFFFF",
  primary: "#176B4D",
  primaryPressed: "#10513A",
  primarySoft: "#DCEFE5",
  accent: "#E6A640",
  accentSoft: "#FFF1D8",
  danger: "#A63C35",
  dangerSoft: "#FBE5E2",
  border: "#D8DED9",
  focus: "#155EEF",
  white: "#FFFFFF",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;

export const shadows: Record<"card", ViewStyle> = {
  card: Platform.select({
    ios: {
      shadowColor: "#17211B",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 12,
    },
    android: { elevation: 2 },
    default: { boxShadow: "0 4px 18px rgba(23, 33, 27, 0.08)" },
  }) as ViewStyle,
};

export const typography: Record<
  "display" | "title" | "heading" | "body" | "caption",
  TextStyle
> = {
  display: {
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "800",
    letterSpacing: -0.8,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  body: { fontSize: 17, lineHeight: 24, fontWeight: "400" },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
};
