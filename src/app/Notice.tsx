export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return <p role="alert" className={`mb-4 rounded-lg border px-3 py-2 text-sm ${error ? "border-red-800 bg-red-950 text-red-200" : "border-emerald-800 bg-emerald-950 text-emerald-200"}`}>{error ?? ok}</p>;
}
