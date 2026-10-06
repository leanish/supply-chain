# supply-chain

Dependency security and freshness for npm and Gradle repositories:

- a **CI gate** that reads base and head against one advisory snapshot and fails a pull request only on what it makes worse (malware always fails);
- **secure-it**, which fixes security findings at any depth with the smallest change;
- **bump-it**, which keeps dependencies fresh, one PR for minors and patches and one per major.

Work in progress: the first pieces land through pull requests. Licensed under Apache-2.0.
