'use client'

export default function BuyerError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center p-5 text-center">
      <div className="w-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Access denied</h1>
        <p className="mt-2 text-sm text-slate-500">You do not have access to this page.</p>
      </div>
    </main>
  )
}
