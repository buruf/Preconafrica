'use client'

export default function StaffError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center p-5 text-center">
      <div className="w-full rounded-card border border-line bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold text-navy-900">Access denied</h1>
        <p className="mt-2 text-[15px] text-muted">You do not have access to this page.</p>
        <a
          href="/"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-btn bg-navy-900 px-4 text-sm font-semibold text-surface hover:bg-navy-800"
        >
          Go to your home page
        </a>
      </div>
    </main>
  )
}
