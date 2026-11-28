# HDRTVNet++ test model

Source: https://github.com/xiaom233/HDRTVNet-plus
Pinned commit: `c77ad33a2d186482ef1f4d23990cbf39d8dbd727`.
Copyright (c) 2023 Hoven Li; MIT licence retained in `LICENSE`.

`AGCM_LE.onnx` is an FP32 ONNX export of `pretrained_models/Ensemble_AGCM_LE.pth`.
The pinned checkpoint SHA256 is
`7cb7be146e5912826dc652c43a8512e47cd58de46abdfa200f6e3a7e5b74e040`.
The export contains the combined adaptive global color mapping and local
enhancement model. Highlight hallucination/refinement is intentionally excluded.

Reproduce with `scripts/export_hdrtvnet.py` in an environment containing PyTorch,
NumPy, ONNX and ONNX Runtime. `scripts/hdrtvnet_arch.py` retains the required
upstream classes; `scripts/hdrtvnet_resize_reference.py` retains the reference
resize used to verify the optimized separable conditioner. Neither PyTorch nor
these development scripts are needed by the packaged application.

Input: full-range nonlinear RGB BT.709 SDR, [0,1], NCHW, batch 1.
Output: full-range RGB BT.2020 PQ, [0,1], same spatial dimensions.
Minimum input dimension: 128. Reflect padding to a multiple of eight is internal
and cropped after inference. Odd-sized inputs therefore include a small reflected
border in the global conditioning image. No tiling is used: the global conditioner
must see the complete frame.

The conditioning downsample matches upstream's antialiased cubic quarter-scale
resize on dimensions divisible by eight. The exported graph was compared to the
FP32 PyTorch model on black, white, random and gradient inputs at three sizes,
including an odd-sized input. `AGCM_LE.json` records hashes and numerical errors.

This is a frame-based model. There is no scene analysis or temporal smoothing in
this test; evaluate brightness/color stability on moving footage and scene cuts.

Instance normalization is lowered to standard reduction/arithmetic ONNX nodes
to avoid requiring a vendor-specific normalization plugin. Export validation
compares the lowered graph with the original PyTorch normalization.
