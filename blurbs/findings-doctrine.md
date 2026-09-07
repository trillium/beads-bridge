# Findings doctrine — constraints and job-fit rules for verification results

15. **Carry verification findings forward as explicit constraints on future resume wording.**
    - Do not treat verification findings as temporary session context.
    - Any finding that establishes, narrows, or disproves a resume claim must be preserved in the retro so the next resume pass does not recreate an unsupported claim.
    - Future agents should consult these findings before rewriting related bullets.

16. **Gas Town cross-machine dispatch is verified and can be used as evidence.**
    - The implementation supports cross-machine dispatch.
    - This is relevant evidence for work involving distributed developer tooling, agent infrastructure, orchestration, and AI-enabled engineering workflows.
    - Resume wording may emphasize the verified cross-machine capability when it strengthens alignment with the target role.

17. **Do not claim remote-DB → local-store failover.**
    - Verification did not support the previously considered claim that Gas Town automatically fails over from a remote database to a local store.
    - Do not restore this wording in later revisions simply because it sounds stronger.
    - If resilience or fallback behavior is important to the target job, either identify separately verified evidence or omit the claim.

18. **Treat findings as job-fit evidence, not merely fact checking.**
    - After verification, explicitly ask: "What does this finding prove that the target employer cares about?"
    - Positive findings should influence which bullets are emphasized, retained, reordered, or expanded.
    - Negative findings should constrain wording without unnecessarily discarding the underlying legitimate experience.

19. **For the Coder AI Enablement Engineer role, prioritize evidence of developer enablement.**
    - Favor experience demonstrating AI tooling, developer workflows, reusable infrastructure, technical enablement, internal tooling, and helping other engineers adopt or operate systems.
    - Evaluate verified Gas Town experience through this lens rather than presenting it merely as an interesting open-source project.

20. **Connect technical implementation to enablement outcomes.**
    - Where evidence permits, bullets should communicate not only what infrastructure was built but how it allowed developers or agents to work more effectively.
    - Prefer the pattern: capability built → technical method → developer/workflow consequence.
    - Do not invent adoption, productivity, reliability, or scale metrics merely to strengthen job alignment.

21. **Use verification strength when deciding resume emphasis.**
    - Strongly verified and highly job-relevant work should receive more prominence.
    - Weakly supported claims should be narrowed.
    - Unsupported claims should be removed.
    - This should influence both bullet wording and bullet ordering.

22. **Job fit should affect structural decisions, not only wording.**
    - When a verified finding makes one project substantially more relevant to the target role, consider moving that bullet higher.
    - When a bullet consumes space without demonstrating capabilities important to the posting, consider cutting or demoting it.
    - Record resulting ORDER and CUT decisions explicitly so they survive the session.

23. **Preserve the distinction between verified capability and inferred impact.**
    - "Cross-machine dispatch exists" is a verified technical capability.
    - Claims about what that capability demonstrates for the Coder role are job-fit interpretation.
    - Claims about measurable organizational impact require separate evidence.
    - Future resume work must not silently turn job-fit interpretation into an asserted historical fact.

24. **Future findings passes should produce two outputs for every material discovery.**
    - **Claim constraint:** exactly what the resume may or may not say based on the evidence.
    - **Job-fit consequence:** whether the finding should cause a bullet to be strengthened, weakened, reordered, cut, or investigated further.
    - This should become an explicit requirement of the findings/verification workflow.

25. **The next-session prompt should explicitly preserve findings across the handoff.**
    - Add instructions requiring the next agent to read the findings and the prior session retro before making wording or structural recommendations.
    - The prompt should explicitly state that verified findings can change job-fit strategy, bullet priority, ordering, and cuts.
    - This prevents factual discoveries made during one session from disappearing during the next refinement pass.
