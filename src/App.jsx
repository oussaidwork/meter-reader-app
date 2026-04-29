import MeterReaderCapture from "./components/MeterReaderCapture";

export default function App() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background:
          "radial-gradient(circle at top right, #e5eefc 0%, #f4f7fb 35%, #eef2f7 100%)",
        padding: "32px 20px",
      }}
    >
      <MeterReaderCapture endpoint="/api/read" />
    </main>
  );
}
