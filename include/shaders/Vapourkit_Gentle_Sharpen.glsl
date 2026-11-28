// Vapourkit SDR shader. Distributed under the project GPL-3.0 license.

//!PARAM STRENGTH
//!DESC Sharpening strength
//!TYPE float
//!MINIMUM 0
//!MAXIMUM 1
0.25

//!DESC Gentle Sharpen
//!HOOK MAIN
//!BIND HOOKED
vec4 hook() { vec4 c=HOOKED_tex(HOOKED_pos); vec3 b=(HOOKED_texOff(vec2(1,0)).rgb+HOOKED_texOff(vec2(-1,0)).rgb+HOOKED_texOff(vec2(0,1)).rgb+HOOKED_texOff(vec2(0,-1)).rgb)*0.25; return vec4(clamp(c.rgb+STRENGTH*(c.rgb-b),0.0,1.0),c.a); }
