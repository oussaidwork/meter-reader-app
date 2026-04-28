import MeterReaderCapture from "./components/MeterReaderCapture";

export default function App() {
  return (
    <main style={{ minHeight: "100vh", background: "#f2f5f9", padding: "24px" }}>
      <MeterReaderCapture endpoint="/api/read" />
    </main>
  );
}
