import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import BrandLogo from '../../components/ui/BrandLogo.jsx';
import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import ResetPasswordForm from './ResetPasswordForm.jsx';
import { forgetSignedOut, readSignedOut } from './signedOut.js';
import { FloorDoodle, greetingFor, IdentifierField, PASSWORD_FIELD_ID, PasswordField, seatedTables, ServiceClock, SignedOutNote, useNow } from './signInParts.jsx';

/**
 * Sign in. P22, DESIGN-SYSTEM sections 4d and 11b.
 *
 * The one screen where the brand gets a large surface. It is drawn in the look
 * of the last restaurant signed in on this device, kept with the device's
 * settings, because nobody has signed in yet to ask the server.
 *
 * With a brand colour: from 900px a full-height `brand` panel on the left,
 * about 40% of the width, with the logo centred, and the form on `ground` to
 * its right; below 900px a 180px `brand` band across the top. The logo is on
 * its own background colour, so it blends into the panel with no edge. No
 * tagline is added: the logo already carries one.
 *
 * Without one, the screen is as it was before P22, with the restaurant's name,
 * or the product's, in place of a hardcoded client's.
 *
 * 2026-10-19, at Rishi's request, livelier and still within DESIGN-SYSTEM
 * section 10: the panel carries the time and day in India, the greeting
 * follows the hour, the phone-or-email field shows what it has read, the
 * password has Show and a Caps Lock warning, a refused sign-in shakes the form
 * once and puts the cursor back in the password, and someone who just signed
 * out is told so. Nothing moves on page load; every motion answers the person.
 */
/**
 * The brand panel: the logo centred on `brand`, or the name in `on-brand` when
 * there is no logo. Exported so the Appearance page previews the real thing.
 * `compact` draws the 180px band a phone shows, at any width.
 */
// The one shake of a refused sign-in, DESIGN-SYSTEM section 10.
const REFUSED_MOTION = 'animate-[refused_280ms_ease-in-out]';

export function BrandPanel({ compact = false, className = '', now = null, seated = null }) {
  const { name } = useTheme();
  if (compact) {
    return (
      <section aria-label={name} className={`flex h-[180px] items-center justify-center bg-brand px-6 ${className}`}>
        <BrandLogo ground="dark" height={120} maxWidth={240} textClassName="type-title text-on-brand" />
      </section>
    );
  }
  return (
    <section
      aria-label={name}
      className={`relative flex h-[180px] flex-none items-center justify-center bg-brand px-6 min-[900px]:h-auto min-[900px]:min-h-full min-[900px]:w-2/5 ${className}`}
    >
      <BrandLogo ground="dark" height={120} maxWidth={240} textClassName="type-title text-on-brand" className="min-[900px]:hidden" />
      <BrandLogo ground="dark" height={148} maxWidth={240} textClassName="type-title text-on-brand" className="hidden min-[900px]:flex" />
      {seated !== null && (
        <FloorDoodle
          seated={seated}
          emptyClass="border-on-brand"
          seatedClass="border-on-brand bg-on-brand"
          className="absolute left-12 top-12 hidden min-[900px]:grid"
        />
      )}
      {now && <ServiceClock now={now} className="absolute bottom-12 left-12 hidden text-on-brand min-[900px]:flex" />}
    </section>
  );
}

export default function LoginPage() {
  const { brand, name } = useTheme();
  const isBranded = Boolean(brand.brandHex && brand.onBrandHex);
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // P34. The sign-in form, or Forgot password in its place.
  const [isResetting, setIsResetting] = useState(false);
  // Each refusal shakes the form once: a new key replays the motion.
  const [refusals, setRefusals] = useState(0);
  // Read once; forgotten after the first paint so a reload does not say it again.
  const [signedOutName] = useState(readSignedOut);
  const now = useNow();
  // A keyboard and mouse at the counter: start in the field. A phone keeps its keyboard down until tapped.
  const [startInField] = useState(() => window.matchMedia?.('(pointer: fine)').matches ?? false);

  const formRef = useRef(null);

  useEffect(() => {
    forgetSignedOut();
  }, []);

  /**
   * After a refusal, once the fields are enabled again: shake the form once and
   * put the cursor in the password with it selected, so typing replaces it.
   * The class comes off and back on so a second refusal shakes again.
   */
  useEffect(() => {
    if (refusals === 0 || isSubmitting) return;
    const form = formRef.current;
    if (form) {
      form.classList.remove(REFUSED_MOTION);
      void form.offsetWidth;
      form.classList.add(REFUSED_MOTION);
    }
    const field = document.getElementById(PASSWORD_FIELD_ID);
    field?.focus();
    field?.select();
  }, [refusals, isSubmitting]);

  // Where they were headed before ProtectedRoute sent them here.
  // P55. With nowhere in particular to go, `/` sends the owner to the dashboard and everyone else home.
  const destination = location.state?.from?.pathname ?? '/';

  // Someone already signed in has no business on this screen. Rendering a
  // redirect rather than calling navigate() during render, which is a side
  // effect in the render phase and warns under StrictMode.
  if (isAuthenticated) return <Navigate to={destination} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // An "@" means it is an email, otherwise it is a phone number. The server
      // takes exactly one of the two.
      const value = identifier.trim();
      const credentials = value.includes('@')
        ? { email: value, password }
        : { phone: value, password };
      await login(credentials);
      navigate(destination, { replace: true });
    } catch (loginError) {
      /**
       * Whatever went wrong, the server says the same thing: the phone number
       * or password is incorrect. Do not try to be more helpful here. A
       * friendlier message like "this account is deactivated" would confirm
       * the account exists, which is the leak the server works to avoid.
       */
      setError(loginError);
      setRefusals((count) => count + 1);
    } finally {
      setIsSubmitting(false);
    }
  }

  // P34. Once a manager has approved the new password, sign in with it.
  async function signInAfterReset(credentials) {
    await login(credentials);
    navigate(destination, { replace: true });
  }

  const resetForm = (
    <ResetPasswordForm
      initialIdentifier={identifier}
      onDone={signInAfterReset}
      onCancel={() => {
        setIsResetting(false);
        setError(null);
      }}
    />
  );

  const signInForm = (
    <form ref={formRef} onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
      <IdentifierField value={identifier} onChange={setIdentifier} disabled={isSubmitting} autoFocus={startInField} />
      <PasswordField value={password} onChange={setPassword} disabled={isSubmitting} />

      {error && <ErrorMessage error={error} />}

      <Button type="submit" size="lg" fullWidth isLoading={isSubmitting}>
        {isSubmitting ? 'Signing in' : 'Sign in'}
      </Button>

      <Button variant="quiet" fullWidth onClick={() => setIsResetting(true)} disabled={isSubmitting}>
        Forgot password?
      </Button>
    </form>
  );

  const form = isResetting ? resetForm : signInForm;

  const greeting = isResetting ? (
    <>
      <h2 className="type-title text-ink">Set a new password</h2>
      <p className="type-body mt-1 text-muted">With an owner or manager beside you.</p>
    </>
  ) : (
    <>
      <h2 className="type-title text-ink">{greetingFor(now)}</h2>
      <p className="type-body mt-1 text-muted">Sign in to start your shift.</p>
    </>
  );

  const seated = seatedTables({ identifier, password, isSubmitting });
  const goodbye = signedOutName !== null && !isResetting ? <SignedOutNote name={signedOutName} /> : null;
  const footnote = <p className="type-caption mt-6 text-muted">Accounts are created by your administrator. There is no self signup.</p>;

  if (isBranded) {
    return (
      <main className="flex min-h-full flex-col bg-ground min-[900px]:flex-row">
        <BrandPanel now={now} seated={seated} />

        <section className="flex flex-1 items-start bg-ground px-4 py-8 min-[900px]:items-center min-[900px]:px-12">
          <div className="w-full max-w-[400px]">
            {greeting}
            {form}
            {goodbye}
            {footnote}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-full flex-col bg-surface lg:flex-row">
      <section className="flex min-h-[260px] flex-col justify-between gap-8 bg-ink p-8 text-surface lg:min-h-full lg:w-[55%] lg:p-12">
        <ServiceClock now={now} />
        <FloorDoodle seated={seated} emptyClass="border-surface" seatedClass="border-surface bg-surface" className="hidden lg:grid" />
        <h1 className="type-heading">{name}</h1>
      </section>

      <section className="flex flex-1 items-center bg-surface px-4 py-8 lg:p-12">
        <div className="w-full max-w-[400px]">
          {greeting}
          {form}
          {goodbye}
          {footnote}
        </div>
      </section>
    </main>
  );
}
