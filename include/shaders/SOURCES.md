# Bundled GLSL shaders

The Anime4K CNN 2× Small, Medium and Large shaders are unmodified copies from
[bloc97/Anime4K, v4.0.1](https://github.com/bloc97/Anime4K/tree/v4.0.1/glsl/Upscale),
commit `4029bf701ecaa15f163cdc49cffe5501c1acf410`.

Copyright (c) 2019–2021 bloc97. Distributed under the MIT license, retained in
each shader and in `Anime4K-LICENSE`.

SHA-256:

- Small: `4c53ec2e287908f7ee7bcb266b0170421626d663576468b7d7dafc62962649a4`
- Medium: `716e02098a68f0d648761f2b96b4dd139e1cb09b174bb369fca3aa34328fff7e`
- Large: `db1fedf7be82f6fd9034e6bf39b64daf2b7576988bb584ec38f24f5236b1cd97`

These are neural shaders trained for anime. Their appearance and performance
should be compared on the user's actual source; they are not substitutes for
all restoration models. They require a 2× output target to activate their
resolution-dependent passes.
