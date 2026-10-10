import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.calyze.app",
  appName: "Calyze",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
