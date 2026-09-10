import { createFileRoute, Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { authClient } from '#/lib/auth-client'
import { getSession, sendEmailVerificationOtp } from '#/server/auth'
import { normalizeAuthError, EMAIL_REGEX } from '#/lib/auth-errors'
import Logo from '#/components/Logo'

export const Route = createFileRoute('/login')({ component: LoginPage })

function isSafeRedirect(url: string) {
  return url.startsWith('/') && !url.startsWith('//')
}

function LoginPage() {
  const navigate = useNavigate()
  const search = useSearch({ from: '/login' })
  const redirect = typeof (search as any)?.redirect === 'string' ? (search as any).redirect : ''
  const getSessionFn = useServerFn(getSession)
  const sendEmailVerificationOtpFn = useServerFn(sendEmailVerificationOtp)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setError('')

    const normalizedEmail = email.toLowerCase().trim()
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setError('Please enter a valid email address.')
      return
    }

    setLoading(true)

    try {
      const res = await authClient.signIn.email({ email: normalizedEmail, password })
      if (res.error) {
        setError(normalizeAuthError(res.error.message || ''))
        setLoading(false)
        return
      }

      // Read verification state off our own session rather than asking about
      // an arbitrary address — the old isEmailVerified endpoint took any email
      // with no session and doubled as an account-existence oracle. The server
      // enforces this too: requireSession() rejects unverified sessions, so
      // this branch is UX, not security.
      const session = await getSessionFn()
      if (!session?.user?.emailVerified) {
        await sendEmailVerificationOtpFn({ data: normalizedEmail })
        navigate({ to: '/signup/verify', search: { email: normalizedEmail, redirect } })
        return
      }

      navigate({ to: isSafeRedirect(redirect) ? redirect : '/discover' })
    } catch (err: any) {
      setError(normalizeAuthError(err?.message || ''))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page-wrap flex min-h-[90vh] flex-col items-center justify-center px-4 py-8">
      <div className="mb-8 text-center">
        <Logo className="mx-auto mb-4 h-20 w-auto" />
        <h1 className="text-2xl font-bold text-[var(--mag-ink)]">Welcome Back</h1>
        <p className="mt-1 text-sm text-[var(--mag-ink-soft)]">Log in to continue swiping</p>
      </div>

      <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
        {error && (
          <div className="rounded-2xl border border-[var(--mag-sale)] bg-[var(--mag-sale-bg)] px-4 py-3 text-xs text-[var(--mag-sale)]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--mag-ink-muted)]" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              required
              className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] py-3 pl-10 pr-4 text-sm text-[var(--mag-ink)] placeholder:text-[var(--mag-ink-muted)] focus:border-[var(--mag-ink)] focus:outline-none"
            />
          </div>

          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--mag-ink-muted)]" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              className="w-full rounded-2xl border border-[var(--mag-line)] bg-[var(--input-bg)] py-3 pl-10 pr-10 text-sm text-[var(--mag-ink)] placeholder:text-[var(--mag-ink-muted)] focus:border-[var(--mag-ink)] focus:outline-none"
            />
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                setShowPassword((prev) => !prev)
              }}
              className="absolute right-0 top-0 z-10 flex h-full w-10 cursor-pointer items-center justify-center border-none bg-transparent text-[var(--mag-ink-muted)] transition hover:text-[var(--mag-ink)]"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <div className="text-center">
            <Link to="/forgot-password" className="text-xs text-[var(--mag-ink)] no-underline hover:underline">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[var(--mag-ink)] px-6 py-3 text-sm font-medium text-[var(--mag-bg)] transition hover:opacity-80 active:scale-95 disabled:opacity-60"
          >
            {loading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--mag-bg)] border-t-transparent" />
            ) : (
              <>
                Log In
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-2 flex flex-col gap-3 rounded-2xl border border-[var(--mag-line)] bg-[var(--mag-card)] p-5 text-center">
          <div>
            <p className="text-sm font-semibold text-[var(--mag-ink)]">Don't have an account?</p>
            <p className="mt-0.5 text-xs text-[var(--mag-ink-soft)]">Join now and start meeting people.</p>
          </div>
          <Link
            to="/signup"
            search={redirect ? { redirect } : undefined}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-[var(--mag-line)] bg-[var(--mag-bg)] px-6 py-3 text-sm font-medium text-[var(--mag-ink)] transition hover:bg-[var(--mag-surface)] no-underline"
          >
            Create Account
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  )
}
