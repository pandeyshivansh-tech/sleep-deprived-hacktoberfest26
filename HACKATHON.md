# Hackathon Project Details

- **Team Name:** Sleep Deprived
- **Team Members:**
  - Akash Pansari
  - Shivansh Pandey
  - Aman Mishra
- **Selected Problem Statement:** Problem 04: Published Package vs Source Code Integrity Analyzer
- **AI Models Used:**
  - `gemma4:e4b` (via local Ollama instance): Fast semantic diff classification (categorizing build artifacts vs. untracked anomalous files).
  - `deepseek-r1:8b` (via local Ollama instance): Deep security reasoning and de-obfuscation to explain malicious logic, suspicious scripts, and supply-chain attack vectors.
- **Justification:**
  - Combining a lightweight instruction model (`gemma4:e4b`) for high-throughput diff categorization with a reasoning model (`deepseek-r1:8b`) for security triage provides fast, explainable verdicts without hitting cloud API limits.
  - Running fully on local Ollama ensures zero network dependency for model inference and zero leakage of audited codebases.
