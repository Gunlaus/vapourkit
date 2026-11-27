// Vapourkit SDR shader. Distributed under the project GPL-3.0 license.

//!PARAM WARMTH
//!DESC Warm / cool tint
//!TYPE float
//!MINIMUM -1
//!MAXIMUM 1
0

//!DESC Warm Cool
//!HOOK MAIN
//!BIND HOOKED
vec4 hook() { vec4 c=HOOKED_tex(HOOKED_pos); return vec4(clamp(c.rgb+WARMTH*vec3(0.08,0.0,-0.08),0.0,1.0),c.a); }
