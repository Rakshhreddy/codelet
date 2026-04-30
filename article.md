# Codelet: small code, instantly delivered

There's a feature on your iPhone you've never stopped to appreciate.

You're logging into something. An OTP lands in your messages. Your keyboard just… knows. It floats the code right above the keypad. One tap. Done.

That's the magic of a seamless experience. You only notice it when it's gone.

I noticed it was gone every time I was applying for jobs.

## The problem

Fill out a 25-minute application. Submit. Verification email arrives. Switch to Gmail. Search. Find the code. Switch back. Paste. The session timed out, or the code expired, or you're just tired of doing this for the 40th time this month.

The iPhone solved this in the background years ago. The browser never caught up. So I built Codelet, a Chrome extension that floats the code over whatever page you're on, the moment it arrives.

## Three bugs that were design decisions in disguise

I built this with Claude Code. I'm a product designer. The interesting work was the judgment calls.

**A code meant for one site started appearing on a completely unrelated one.** Two different flows, one piece of state hanging around between them. The question I had to answer was how long a verification code stays relevant. About 15 seconds, and only on the page that triggered it. The moment you navigate away, it's gone. A code is tied to a specific moment of intent. Once that moment passes, it becomes noise.

**A brand name was being detected as a verification code.** The system saw mixed-case letters and assumed it was the kind of alphanumeric code some products send. The real question I'd skipped was simpler: what does a code actually look like? Random codes have three or more uppercase letters scattered unpredictably. Brand names follow English title case. I never had a written definition of "code-shaped." The bug forced me to write one.

**Auto-fill was injecting codes into resume fields, search bars, anywhere it found an input.** So I removed automatic fill entirely. If the system can't be confident about where the code belongs, it shouldn't guess. Show the code. Let the user decide.

## Why this matters

There's a version of a product designer who waits for an engineer to build the thing they've specified. There's another version who can close the gap themselves. Prototype faster, catch problems earlier, ship independently.

I've always been closer to the second. Codelet is the clearest proof I have.

🔗 [github.com/Rakshhreddy/codelet](https://github.com/Rakshhreddy/codelet)
