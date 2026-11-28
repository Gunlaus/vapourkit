# Added UI copy review

This tracks explanatory text introduced with the performance and shader work,
so further wording changes can be reviewed without adding labels to the app.

| Location | Decision |
| --- | --- |
| `ShaderSettingsCard.tsx` | Removed repeated shader description, backend explanation, and output-scale explanation. The selector and scale control already provide these. |
| `ShaderSelectorModal.tsx` | Removed the backend-routing paragraph. Retained per-shader descriptions, categories, and installation actions. |
| `PipelineSettingsPanel.tsx` | Removed preview implementation guidance and shortened scheduling help to “0 uses the runtime defaults.” Retained the CUDA Graphs explanation for the optional setting. |
| `RtxRuntimePanel.tsx` | Replaced two technical paragraphs with selection and first-use compilation guidance. |
| `ShaderEditDialog.tsx` | Retained the note that edits affect future selections; this explains why an existing workflow does not change automatically. |

Keep actionable errors, download sizes, licence/source information and shader
parameter labels. Shader descriptions belong in the library; the filter card
should focus on editable settings.

## Encoder follow-up

Keep the user-tested NVEncC 9.41 and upstream CPU encoders for this consolidation.
NVEncC 9.42 and SVT-AV1-Essential require separate hardware/quality comparisons;
they are not established performance fixes. The Windows FFmpeg installer reuses
an existing executable, so its linked encoder versions depend on installation
date, not the Vapourkit application version.
