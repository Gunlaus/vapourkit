// Vapourkit SDR shader. Distributed under the project GPL-3.0 license.

//!DESC Grayscale
//!HOOK MAIN
//!BIND HOOKED
vec4 hook() { vec4 c=HOOKED_tex(HOOKED_pos); float y=dot(c.rgb,vec3(0.2126,0.7152,0.0722)); return vec4(vec3(y),c.a); }
