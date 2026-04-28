# Meter Reader App (React Frontend)

This frontend includes a reusable React component for uploading a meter image and reading the value through an API.

## Recommended project choice

- Use [`nliaudat/meter-reader`](https://github.com/nliaudat/meter-reader) if you want quick software integration from React to a Python API.
- Use [`jomjol/AI-on-the-edge-device`](https://github.com/jomjol/AI-on-the-edge-device) if you are deploying ESP32 camera hardware at each meter.

For your current goal ("help workers read mechanical counters quickly"), the first option is usually faster to integrate.

## Added component

- `src/components/MeterReaderCapture.jsx`
  - Uploads an image
  - Sends it to a backend endpoint (default: `http://127.0.0.1:5000/api/read`)
  - Displays recognized value + confidence
  - Shows raw JSON response for debugging

## Basic integration

1. Start a backend meter reading service (e.g. based on `meter-reader`).
2. Make sure your backend accepts `multipart/form-data` with `image`.
3. Return JSON with one of these keys for value:
   - `reading` or `value` or `result` or `digits`
4. Update endpoint in `src/App.jsx` if needed.

## Note

Check licensing before commercial deployment:
- `meter-reader` is CC-BY-NC-SA (non-commercial restriction).
