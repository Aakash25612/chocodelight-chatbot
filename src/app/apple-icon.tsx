import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(145deg, #18181b 0%, #3f3f46 100%)",
          borderRadius: 36,
        }}
      >
        <div
          style={{
            color: "#ffffff",
            fontSize: 56,
            fontWeight: 800,
            letterSpacing: "-0.05em",
          }}
        >
          BC
        </div>
      </div>
    ),
    { ...size },
  );
}
