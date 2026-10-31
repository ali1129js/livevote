import { CreatePoll } from "./components/CreatePoll";
import { PollPage } from "./components/PollPage";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { useRoute } from "./router";
import { useTheme } from "./theme";

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a href="#/" className="brand" aria-label="LiveVote home">
          <span className="brand-mark" aria-hidden="true">✓</span> LiveVote
        </a>
        <ThemeSwitcher theme={theme} onChange={setTheme} />
      </header>
      <main id="main" className="page">
        {route.name === "create" && <CreatePoll />}
        {route.name === "poll" && <PollPage key={`${route.pollId}/${route.hostToken ?? ""}`} pollId={route.pollId} hostToken={route.hostToken} />}
        {route.name === "notfound" && (
          <div className="card stack">
            <h1>Page not found</h1>
            <p>That link doesn't look right. Ask whoever shared it to send it again.</p>
            <p>
              <a className="btn btn-primary" href="#/">
                Start a new poll
              </a>
            </p>
          </div>
        )}
      </main>
    </>
  );
}
