import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Saira Condensed", "Bahnschrift", "sans-serif"],
        body: ["Aptos", "Segoe UI", "sans-serif"]
      },
      colors: {
        ink: "#17130f",
        paper: "#f3eadc",
        panel: "#261f18",
        signal: "#e59c37",
        verdict: "#5f7f5a",
        danger: "#c6533d"
      }
    }
  },
  plugins: []
} satisfies Config;
