import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0b0e14",
          raised: "#11151d",
          border: "#1f2530",
        },
      },
    },
  },
  plugins: [],
};

export default config;
