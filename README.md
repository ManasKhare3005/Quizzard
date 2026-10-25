# 🧙 Quizzard

**Study or pay.** Quizzard turns your group chat into a quiz battle. Type `@test`, Cubbie writes a quick quiz from your class's real course materials, the group votes on a time, everyone checks in, and points add up all month. At the end of the month Cubbie posts a scorecard, crowns the Quizzard of the month, and last place treats the group.

Built for the [Cubbie Hackathon](https://hackathon.cubbie.ai), Track 3 (Group Chat Assistant). It runs on Cubbie as a Cubbie Skill and works in any group chat Cubbie is in, including groups that mix iMessage and Android (SMS/RCS).

## How a round goes

```
Reya:    @test
Cubbie:  Coming up: 1) CSE 576 midterm Nov 3: backprop, CNNs  2) MAT 343 quiz: eigenvalues
Reya:    1, backprop
Cubbie:  A) Thu 8 pm  B) Fri 6 pm. Reply A or B.
...
Cubbie:  Locked: Backprop, Thu 8 pm. 5 questions, 10 min.
(7:30)   Quiz in 30 min. Reply ready, or excused.
(7:50)   Sam hasn't checked in. Someone call him! No check-in by 8:00 = DQ.
(8:00)   Quizzard is live. Check your texts.        <- questions go to each player 1:1
(8:11)   🥇 Jay 61 · 🥈 Reya 49 · 🥉 Sam 26
         Most missed: Q3, the ReLU gradient. Answer B: it's flat below zero. (Lecture 9, slide 6)
```

End of the month:

```
Quizzard of the month: Jay 👑
Sam treats the group, up to $25 🧋
```

## What makes it fair

- **Private answers.** Questions go to each player 1:1 and are revealed together at the end, so nobody copies.
- **Server-side scoring.** The relay hides questions until the start and answers until the end, timestamps every answer and does all the math: 10 per right answer, up to +5 for speed, +2 per answer in a streak.
- **Check-ins, not calls.** Ready or excused, 30 minutes before. At 10 minutes the group is told who is missing so friends can call them. No check-in by the start is a DQ for that round only, and excused is never penalized.
- **A capped treat.** Last place treats the group to something small, up to the budget the group picked.
- **Learning, not just points.** Every recap explains the most missed question with its source slide, and asks the round winner to teach it.

## Repo layout

| Path | What |
| --- | --- |
| `quizzard/SKILL.md` | The Cubbie Skill: what Cubbie does at each step, in plain words |
| `quizzard/scripts/quizzard.py` | Stdlib-only client the Skill runs (state in `~/.config/quizzard`, mode 600) |
| `relay/` | Vercel + MongoDB relay: groups, quizzes, check-ins, scoring, monthly scorecard |
| `relay/public/scorecard.html` | The read-only monthly scorecard card |
| `relay/test/` | End-to-end relay tests on an in-memory store with a fake clock |

## Install on Cubbie

Text Cubbie the link to the Skill folder:

```
https://github.com/ManasKhare3005/Quizzard/tree/main/quizzard
```

Then add Cubbie to a group chat and type `@test`.

## Run the relay

```bash
cd relay
npm ci
npm test                 # 6 end-to-end tests, no database needed
node dev-server.mjs      # local relay on http://localhost:8787 (in-memory)
```

Deploy `relay/` to Vercel with `MONGODB_URI` set (and optionally `MONGODB_DB`, default `quizzard`). Point the Skill at another relay with `QUIZZARD_SERVER=https://...`.

## Privacy

The relay stores display names, quiz topics, the questions Cubbie wrote, and answers with timestamps. No phone numbers, grades, messages or calendars. Tokens are stored as SHA-256 hashes. The scorecard link carries a separate view-only key in the URL fragment, which can read the scorecard and nothing else. Leaving a group deletes your points and answers; the last member leaving deletes the group.
