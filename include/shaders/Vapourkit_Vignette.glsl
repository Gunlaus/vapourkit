// Vapourkit SDR shader. Distributed under the project GPL-3.0 license.

//!PARAM STRENGTH
//!DESC Edge darkening
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 1
0.35

//!DESC Vignette
//!HOOK MAIN
//!BIND HOOKED
vec4 hook() { vec4 c=HOOKED_tex(HOOKED_pos); vec2 p=(HOOKED_pos-0.5)*2.0; return vec4(c.rgb*(1.0-STRENGTH*smoothstep(0.2,1.4,length(p))),c.a); }
