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

**A Western Alliance OTP showed up on a RealPage password reset screen.** Two unrelated flows, one stale code. I made codes live for 15 seconds and die the moment you navigate away. State has a half-life.

**The word "RealPage" was being detected as a verification code.** Mixed-case, looks like Greenhouse's `mTjzdPVi`. I wrote a sharper rule. Real codes have three or more uppercase letters scattered unpredictably. Brand names don't. The bug came from never defining what "code-shaped" actually means.

**Auto-fill was injecting codes into resume fields and search bars.** I removed automatic fill entirely. Don't be clever when you don't have full context. Show the code. Let the user decide.

## Why this matters

There's a version of a product designer who waits for an engineer to build the thing they've specified. There's another version who can close the gap themselves. Prototype faster, catch problems earlier, ship independently.

I've always been closer to the second. Codelet is the clearest proof I have.

🔗 [github.com/Rakshhreddy/codelet](https://github.com/Rakshhreddy/codelet)
