# Prompt Checker

Prompt Checker helps student groups learn to ask AI for useful help during classroom activities.

Groups submit prompts for the teacher to review. The teacher can approve a prompt or return it with feedback so the group can revise it. Only approved prompts reach the AI.

The activity can stay in a textbook, on the board, or on paper. The same review process works across subjects.

After a prompt is approved, the group must wait four minutes from the teacher’s approval before submitting another. If the teacher returns a prompt, the group can revise and resubmit it immediately. This limits repeated submissions and gives groups time to work on the task and think through their next question.

## Set up on Windows

1. Download or clone this repository. If you downloaded a ZIP, extract it first.
2. Install [Node.js 24 LTS](https://nodejs.org/en/download) and [Ollama for Windows](https://ollama.com/download/windows). Ollama requires Windows 10 22H2 or newer. Allow at least 7 GB of free disk space for Ollama and the 2.5 GB model. You need internet access for these downloads. [Ollama requirements](https://docs.ollama.com/windows)
3. Open Ollama from the Start menu. Open a new PowerShell window and run:

   ```powershell
   node --version
   ollama pull qwen3:4b-instruct
   ollama list
   ```

   Check that Node reports version 24 or later and that `qwen3:4b-instruct` is listed. To check that the model can answer on your laptop, run `ollama run qwen3:4b-instruct "What is 2 + 2?"`.

## Run locally

In PowerShell, open the extracted or cloned folder containing `server.mts` and run:

```powershell
node .\server.mts
```

1. Open [Teacher View](http://127.0.0.1:3000/teacher). Enter the value after `Teacher key:` in PowerShell. The server generates a new key each time it starts.
2. Open [Group View](http://127.0.0.1:3000/) in a second tab. Enter one of the codes listed under **Group codes** in Teacher View.
3. Submit a test prompt, approve it in Teacher View, and check that the reply appears in Group View.

Press Ctrl+C in PowerShell to stop the server. The app runs with Node directly. Its npm dependencies are only for tests.

## Use student devices

On the teacher's computer, set `$env:HOST = '0.0.0.0'` in PowerShell before starting the server. Run `ipconfig` to find the computer's local IPv4 address and share `http://<teacher-ip>:3000/` with the groups. Students on the same network open that address in a browser on their device and enter their group code. Test from a student device first. The school network or Windows Firewall may block connections between devices.

## Troubleshooting

- **Command not found.** Open a new PowerShell window after installing Node.js or Ollama.
- **Ollama connection error or missing model.** Open Ollama from the Start menu and check `ollama list`.
- **Slow or failed AI reply.** Generation on CPU can be slow. Try an approved prompt before class. The app waits up to 90 seconds. The teacher can retry a failed generation.
- **Port 3000 already in use.** Stop the previous server or set `$env:PORT = '3001'` before starting and use port 3001 in the URLs.

To try the review flow without installing Ollama, set `$env:AI_MODE = 'simulated'` before starting the server. Run `Remove-Item Env:AI_MODE` before restarting with Ollama.
