# Chatium processes skill

This repository is the source of the `processes` skill. Development happens here;
copies inside Chatium accounts are installations, not separate sources. The skill
will later move into `chatium-agent-skills` beside `chatium-development`.

## Install in a Chatium account

The account needs the `chatium-development` skill, Node.js 20+, Git, and the
Chatium CLI. Clone this repository separately from the account, then run:

```sh
./install.sh '/absolute/path/to/account'
```

The installer updates only `<account>/.agents/skills/processes/`, excludes the
repository's `.git`, and runs `npm ci --ignore-scripts` for the skill's YAML
dependency. It replaces files in that dedicated directory, so review local
changes there before updating. After a new release, pull this repository and
run the installer again. To test a fixed version, check out its tag first.

The installed copy can be committed to an account when the account's Git build
must include the skill. Do not edit that copy as the upstream source. The
runtime requirements and platform access are described in
[build/environment.md](build/environment.md).
