# Project Instructions

## Voice-input corrections

The user commonly uses voice input. Interpret the following likely speech-recognition substitutions throughout this project:

- “绘画” usually means “会话”.
- “节点数” means “节点树”.

Apply these corrections by default. If the surrounding context clearly conflicts with a correction, ask the user to confirm the intended term.

## Plan operation

All implementation plans must be written under `docs/plan/` and follow [`docs/standards/global/plan-operation.md`](docs/standards/global/plan-operation.md).

## Interaction-design comprehension

Before implementing an interaction, evaluate it from the perspective of a first-time user who has no prior knowledge of the system. Aim for “what is visible is enough to understand.”

For every information or action area, make sure the interface either explains or provides an obvious way to learn:

- what the content means and what its hidden system implications are;
- all context the user needs to make the intended decision;
- all information and inputs required to complete the interaction.

When this information should not be shown inline, provide a clear, reachable detail or help entry so the user can finish the workflow without guessing.
