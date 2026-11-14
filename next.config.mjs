/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / Node-only packages must not be bundled.
  serverExternalPackages: ["@node-rs/argon2", "pg", "@prisma/client", "@prisma/adapter-pg"],
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    }];
  },
};
export default nextConfig;
