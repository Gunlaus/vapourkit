
# Startup, sessions, and filter discovery

Normal preview and encode graph construction no longer requests first/early/last frames at each model and again at final output. Those last-frame requests could seek through or decode large portions of the source before showing a picture. Explicit workflow validation executes one first output frame through the whole graph. Candidate engine validation (profile inference and numerical comparison where available) remains in place at build time.

Unchanged model contracts and engine hashes are cached across script processes using filesystem size, timestamps and identity. Model bytes, weights or descriptors changing invalidates the appropriate entry. This avoids hashing the same large engine multiple times during each script evaluation. Cache files are disposable sidecars; failures to write caches do not stop processing. This is a filesystem change cache, not tamper-proof storage.

Linux caches a successfully resolved site-packages path instead of spawning Python on every path getter. The separate vs-view launch no longer evaluates the same graph in vspipe before vs-view evaluates it again. Its package checks share one pip listing. The warm in-app preview still retains its existing session and rendering paths; these changes do not claim measured GPU throughput improvements.

Each window starts a fresh working document: no loaded video, filters, encoding overrides, active workflow label or resumed queue-item editor. GPU/backend preference, app preferences, explicitly exported workflow files and saved queue jobs remain available. Open a workflow or select a saved queue job explicitly. The implementation uses the requested fresh-start policy, rather than adding an exit prompt.

Get more filters in the VS filter picker opens an internal VSRepo browser. It downloads the official vspackages3 registry, shows names/descriptions/API metadata, selects matching Windows/Linux x64 artifacts and resolves registry dependencies. Native API3 and undeclared-API artifacts are not automatically installed into R79. A compatible registry entry is not proof of every driver/dependency requirement; staging checks actual plugin/script loading before publishing files.

Only named archive members are extracted and matched against their registry SHA-256. Existing differing files are preserved and installation fails with an explanation. New files are rolled back on failure. No in-place dependency upgrades or arbitrary pip commands run. Simple functions taking one clip and only optional remaining arguments receive editable VSRepo filter templates. Other functions and scripts are available to custom filter code; arbitrary parameter choices are not guessed. Reopen the filter picker and any already-open preview to use new plugins.

CI covers lazy graph construction, warm-cache invalidation, fresh-session policy, registry API/platform policy, mocked transport installation/checksum/conflict/dependency behavior, and browser interaction. Physical GPU startup timings and third-party plugin execution on user hardware still need measurement. The development workspace went offline during this task; verification ran in GitHub Actions instead.
