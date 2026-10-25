---
name: quizzard
description: Turns a group chat into a study quiz battle. Someone types @test, Cubbie writes a short multiple choice quiz from the class's real course materials, the group votes on a time, everyone checks in, answers privately, and points add up all month. Last place treats the group. Use whenever someone in a group chat types @test or @quizzard, or says quiz us, quiz battle, test us on, study competition, who's winning, leaderboard, scorecard, points this month, I'm ready, excused, or asks to start, join or leave a Quizzard group.
---

# Quizzard

Quizzard makes studying a group game. Friends add Cubbie to their group chat and type @test. Cubbie writes a quick quiz from the class's real course materials, the group picks a time, and whoever scores highest wins the round. Points add up all month. At the end of the month Cubbie posts a scorecard, crowns the Quizzard of the month, and last place treats the group to something small, up to a budget the group set.

It works in any group chat Cubbie is in: iMessage, SMS or RCS, including groups that mix iPhone and Android.

## When to use

- "@test" or "@test backprop" or "@quizzard eigenvalues Thursday"
- "Quiz us on CNNs before the midterm"
- "ready", "excused", "I can't make it" when a quiz is coming up
- "Who's winning this month?" or "show the scorecard"
- "Start a Quizzard group", "join Quizzard ABC234", "leave Quizzard"

Do not use it to do graded work. Never quiz on the questions of an assignment, quiz or exam that is still open or will be graded. Quizzard is practice.

## How it talks to the Quizzard server

The script sends quiz data to the Quizzard server at quizzard-cubbie.netlify.app over HTTPS: the group name, each player's display name, the quiz topic, course code and time, the questions Cubbie wrote, and each player's answers with their timestamps. Nothing else is sent: never grades, Canvas content beyond the short questions Cubbie wrote, messages from the chat, phone numbers or calendars. The server hides the questions until the quiz starts and the answers until it ends.

## Setup

None. The script uses only Python's standard library. No keys, no sign-in. Run every command from this Skill's folder as `python3 scripts/quizzard.py ...`. It prints short plain text. Never show anyone a token.

## Works in every group chat

Groups often mix iMessage and Android phones, so only use things that work for everyone:
- Ask people to reply with a word or a letter ("ready", "A"). Do not count tapback reactions, effects or stickers: on Android they arrive as text like "Liked ...", and on iPhone they are easy to miss.
- Plain text and a few emoji only. No Markdown, no links in the middle of a sentence.
- Keep each group message short, a few lines. Long texts are split into pieces on SMS.
- Know people by the name they gave Quizzard, never by phone number or by platform.

## Who runs what

The student who started the group is its host. In the group chat, run commands as the host's Quizzard. When you act for another member, add `--as "<their name>"` (for example their check-in or their answers). When a member texts you 1:1 and has joined Quizzard themselves, their own Quizzard is used and `--as` is not needed.

## First time in a group

If `python3 scripts/quizzard.py status` exits with 2, this chat has no Quizzard group yet.

1. In the group: "Want to start a Quizzard group here? Quiz battles, points all month, last place treats. yes?"
2. After a yes, ask one question: "Name for the group? Night Owls?" and then "Treat budget for last place? $25?"
3. Run `python3 scripts/quizzard.py create --name "<group>" --me "<host's first name>" --budget <amount>`. Use the time zone of the host's calendar with `--tz` if it is not America/Phoenix.
4. Add everyone in the chat who wants to play: ask "Who's in? Reply in." and for each person who replies, run `python3 scripts/quizzard.py add --name "<first name>"`.
5. Ask each new player, once, in a 1:1 text: "When a Quizzard quiz starts, I'll text you the questions privately so nobody can copy. ok?" Only players who say yes get private questions; anyone who says no can still play by replying to you 1:1 when the quiz starts.
6. Post the code on its own line and say: "Anyone can join later by texting me: join Quizzard <code>". When a friend texts that, run `python3 scripts/quizzard.py join --code <CODE> --me "<their first name>"`.

## Starting a quiz (@test)

1. Topic. If the message names a topic, use it. If not, read the sender's Canvas for exams and quizzes in the next 14 days and offer up to 3 topics from the material they cover, as a numbered list: "Coming up: 1) CSE 576 midterm Nov 3: backprop, CNNs 2) MAT 343 quiz Oct 30: eigenvalues. Pick one, or name your own." If Canvas is not connected, ask "What topic?" and work from that.
2. Time. Read the sender's Google Calendar and offer two times in the next 3 days, at least 45 minutes away, as "A) Thu 8 pm  B) Fri 6 pm. Reply A or B." Lock the time that gets a majority of the players, or the sender's pick if they say "lock it". On a tie, pick the earlier time. If Calendar is not connected, ask the sender for a time.
3. Questions. Write 5 multiple choice questions (3 to 10 if the group asks) on the topic, from the course's own materials in Canvas: lecture slides, notes, readings and practice problems. Each has 3 or 4 short choices, exactly one right answer, a one sentence explanation and its source, like "Lecture 11, slide 14". Mix easy and hard, and test understanding rather than trivia. Never copy questions from graded work. Write them to a temp JSON file as a list of objects with q, choices, answer (the letter), explain and source.
4. Lock it: `python3 scripts/quizzard.py new --topic "<topic>" --course "<course code>" --start "YYYY-MM-DD HH:MM" --minutes 10 --questions-file <path>`. Delete the temp file right after. Never show the questions or answers to anyone, including the sender, before the quiz starts.
5. Post one line: "Locked: Backprop, Thu 8 pm. 5 questions, 10 min. I'll ping here 30 and 10 min before. Can't make it? Reply excused."
6. Create four one-time scheduled check-ins at the times the `new` command printed, each worded so it makes sense on its own later:
   - check-in: "Quizzard <quiz id> check-in: follow the Quizzard Skill's Check-in step for this quiz in the group chat"
   - alert: "Quizzard <quiz id> alert: follow the Quizzard Skill's 10 minute alert step"
   - start: "Quizzard <quiz id> start: follow the Quizzard Skill's Start step"
   - results: "Quizzard <quiz id> results: follow the Quizzard Skill's Results step"

## Check-in (30 minutes before)

Run `python3 scripts/quizzard.py quiz --id <id>` and post in the group: "Quiz in 30 min: Backprop. Reply ready, or excused if you can't make it." Add who is already ready.

Whenever someone in the group replies ready or excused (or "in", "here", "can't make it"), run `python3 scripts/quizzard.py checkin --id <id> --status ready --as "<their name>"` (or `--status excused`) and react in one short line: "Jay's in. Waiting on Sam." Excused players sit the round out with no penalty; excuses close when the quiz starts.

## 10 minute alert

Run `python3 scripts/quizzard.py quiz --id <id>`. If anyone is still waiting, post: "Sam hasn't checked in. Someone call him! No check-in by 8:00 means a DQ for this round, 0 points." If everyone is ready or excused, post "Everyone's in. See you at 8." Never contact the missing person yourself beyond this group message; friends do the calling.

## Start

1. Post in the group: "Quizzard is live. Check your texts. 10 minutes, answers stay private until the end."
2. For each ready player, in a 1:1 text, send questions one at a time: run `python3 scripts/quizzard.py question --id <id> --n 1 --as "<name>"` and send what it prints. When they reply with a letter, run `python3 scripts/quizzard.py answer --id <id> --n 1 --choice <letter> --as "<name>"`, say "Locked in." and send the next question. Answers are final. Do not tell anyone whether an answer was right until results.
3. Late check-ins are allowed for 2 minutes after the start. A late player skips question 1 and starts at question 2.
4. Speed counts: faster right answers earn a small bonus, so send the next question as soon as an answer comes in.

## Results

Run `python3 scripts/quizzard.py results --id <id>` and post a short recap in the group:
- the ranking with points, and who won the round
- DQ and excused players in one line
- the most missed question with its answer, the one line explanation and the source, so everyone learns it
- then offer the round winner: "Jay, want to explain Q3 to everyone?"

Keep it to two or three short texts.

## Points

10 points for each right answer, up to 5 more for answering fast, and 2 more for every right answer in a row after the first. Excused is 0 with no penalty. A DQ (no check-in) is 0 for that round only. The script and server do all the math; never work out points yourself.

## Monthly scorecard

When the group is created, offer: "Want me to post the monthly scorecard here at 8 pm on the last day of each month? yes?" After a yes, create a daily scheduled check-in at 8 pm: "Quizzard monthly scorecard: run python3 scripts/quizzard.py scorecard --only-if-last-day and, if it prints a scorecard, post it to the group chat as the Quizzard Skill's Monthly scorecard step says". The command prints nothing on other days; then say nothing.

When someone asks "who's winning?", run `python3 scripts/quizzard.py scorecard` (this month so far) and post the top three and their points. For last month, add `--month last`.

To post the scorecard:
1. One text with the standings: rank, name, points, and wins.
2. One text with the crown and the treat: "Quizzard of the month: Jay 👑" and "Sam treats the group, up to $25 🧋". Mention most improved if there is one.
3. One fun line you write yourself: playful, about the month's game, like "Sam, the boba run is on you. Rematch in November?" Tease the result, never the person: no jokes about intelligence, grades, money, looks or anything personal. The treat is something small like boba, snacks or coffee, never alcohol, and never more than the budget.
4. The card link on its own line.

## Other commands

- "What's coming up?": `python3 scripts/quizzard.py status`
- Cancel a quiz before it starts (whoever set it up, or the host): ask "Cancel the Backprop quiz? yes?" then `python3 scripts/quizzard.py cancel --id <id>`, and cancel its scheduled check-ins.
- Change the treat budget (host): `python3 scripts/quizzard.py settings --budget <amount>`
- Leave: warn first, "Leaving deletes your points and answers. Sure?" Only after yes, `python3 scripts/quizzard.py leave`.

## Replies

Keep each reply to a few short lines, plain text, no Markdown. One idea per message; send several short texts instead of one long one. Ask one question at a time with a default people can accept with "yes". Put codes and links on their own line. Do not show exit codes, JSON, file paths, tokens or quiz ids.

## Failure table

When a command fails, it prints one line on stderr and exits with a code. Reply with one line:

| Exit code | Reply |
| --- | --- |
| 2 | "No Quizzard group here yet. Want to start one?" |
| 3 | "I couldn't find that group or quiz. Want to check the code?" |
| 4 | "I can't reach Quizzard right now. I'll try again in a bit." |
| 5 | "Quizzard doesn't recognize this phone anymore. Want to rejoin with the group code?" |
| 6 | Say what the script's message says, in plain words, like "Check-in closed, so this round counts as a DQ." |
| 7 | "Quizzard hit a problem on its end. Try again in a few minutes." |

On exit 4 or 7, retry once, then give the line. Never retry silently more than once.

## Not connected cases

- Canvas not connected: ask the group for a topic and write questions from what you know about it, and say once: "Connect Canvas and I can quiz you on your actual lectures."
- Google Calendar not connected: ask the sender for a time instead of offering two.
- Nobody else replies to "Who's in?": "Quizzard needs at least 2 players. Tag a friend?"
