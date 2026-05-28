EMCC     = emcc

# WebAssembly optimizations: Max speed (-O3), Link-Time Optimization (-flto), and relaxed math (-ffast-math)
CXXFLAGS = -O3 -flto -ffast-math -std=c++17

# Expose the necessary C++ functions to the JavaScript bridge
EXPORTS  = '["_update","_initUniformDust","_getParticleBuffer","_getParticleCount","_addParticle","_setTheta"]'
RUNTIME  = '["ccall","cwrap"]'

wasm:
	$(EMCC) $(CXXFLAGS) \
	  -s WASM=1 \
	  -s ALLOW_MEMORY_GROWTH=1 \
	  -s EXPORTED_FUNCTIONS=$(EXPORTS) \
	  -s EXPORTED_RUNTIME_METHODS=$(RUNTIME) \
	  -s ENVIRONMENT='web' \
	  cosmosim.cpp -o cosmosim.js
	# Copy artifacts to docs/ to serve the frontend via GitHub Pages
	cp cosmosim.js cosmosim.wasm docs/

native:
	g++ -O2 -std=c++17 -o cosmosim_native cosmosim.cpp

serve:
	http-server . -p 8080 --cors

clean:
	rm -f cosmosim.js cosmosim.wasm cosmosim_native

.PHONY: wasm native serve clean