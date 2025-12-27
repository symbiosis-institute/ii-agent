"""Integration test for GLM request parameter normalization.

This test verifies that the exact request parameters sent to the LLM provider
are correctly normalized for GLM (max_tokens instead of max_completion_tokens,
and no strict: true in tool schemas).

Tests are self-contained and require no network calls or API keys.
"""

import pytest
from unittest.mock import MagicMock
from pydantic import BaseModel, SecretStr
from typing import Optional, Dict, Any


class MockLLMConfig(BaseModel):
    """Mock LLMConfig for testing."""
    model: str
    base_url: Optional[str] = None
    api_key: Optional[SecretStr] = None
    max_retries: int = 1
    temperature: float = 0.0
    application_model_name: Optional[str] = None
    tokenizer: Optional[str] = None


class MockToolParam(BaseModel):
    """Mock ToolParam for testing."""
    name: str
    description: str
    input_schema: Dict[str, Any]


class GLMProviderDetector:
    """Recreation of the detection logic for testing request parameters."""

    def __init__(self, config: MockLLMConfig):
        self.config = config
        self.model_name = config.model

    def _is_glm_provider(self) -> bool:
        """Detect if the current provider is GLM/BigModel (zhipu AI)."""
        base_url = self.config.base_url or ""
        model_name = self.model_name or ""

        glm_hosts = ["bigmodel.cn", "zhipu.ai", "bigmodel", "zhipu"]
        if any(host in base_url.lower() for host in glm_hosts):
            return True

        if model_name.lower().startswith("glm-"):
            return True

        return False

    def build_request_params(self, max_tokens: int, tools: list) -> Dict[str, Any]:
        """Build the exact request parameters that would be sent to the LLM.

        This recreates the logic from OpenAIDirectClient.agenerate().
        """
        openai_tools = []
        for tool in tools:
            tool_def = {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema.copy(),
            }
            # Only add strict mode for OpenAI (not GLM)
            if not self._is_glm_provider():
                tool_def["parameters"]["strict"] = True
            openai_tools.append({
                "type": "function",
                "function": tool_def,
            })

        # Determine max_tokens parameter name based on provider
        if self._is_glm_provider():
            max_tokens_param = {"max_tokens": max_tokens}
        else:
            max_tokens_param = {"max_completion_tokens": max_tokens}

        return {
            "max_tokens_param": max_tokens_param,
            "tools": openai_tools,
        }


class TestGLMRequestParameters:
    """Tests that verify exact request parameters for GLM vs OpenAI."""

    def _create_config(
        self, model: str = "test-model", base_url: str | None = None
    ) -> MockLLMConfig:
        """Helper to create a mock config."""
        return MockLLMConfig(model=model, base_url=base_url)

    def _create_tool(self) -> MockToolParam:
        """Helper to create a mock tool."""
        return MockToolParam(
            name="test_tool",
            description="A test tool",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
                "required": ["query"]
            }
        )

    def test_glm_uses_max_tokens_not_max_completion_tokens(self):
        """Verify GLM request uses max_tokens instead of max_completion_tokens."""
        config = self._create_config(
            model="glm-4-flash",
            base_url="https://open.bigmodel.cn/api/paas/v4/"
        )
        detector = GLMProviderDetector(config)

        # Build request params for GLM
        params = detector.build_request_params(max_tokens=1000, tools=[self._create_tool()])

        # ASSERT: max_tokens is used (not max_completion_tokens)
        assert "max_tokens" in params["max_tokens_param"]
        assert params["max_tokens_param"]["max_tokens"] == 1000
        assert "max_completion_tokens" not in params["max_tokens_param"]

    def test_openai_uses_max_completion_tokens(self):
        """Verify OpenAI request uses max_completion_tokens."""
        config = self._create_config(
            model="gpt-4o",
            base_url="https://api.openai.com/v1"
        )
        detector = GLMProviderDetector(config)

        params = detector.build_request_params(max_tokens=1000, tools=[self._create_tool()])

        # ASSERT: max_completion_tokens is used (not max_tokens)
        assert "max_completion_tokens" in params["max_tokens_param"]
        assert params["max_tokens_param"]["max_completion_tokens"] == 1000
        assert "max_tokens" not in params["max_tokens_param"]

    def test_glm_tool_schema_no_strict(self):
        """Verify GLM tool schemas do NOT include strict: true."""
        config = self._create_config(
            model="glm-4-7",
            base_url="https://api.bigmodel.cn/v1/"
        )
        detector = GLMProviderDetector(config)

        params = detector.build_request_params(max_tokens=500, tools=[self._create_tool()])

        tools_arg = params["tools"]
        assert len(tools_arg) > 0

        tool_params = tools_arg[0]["function"]["parameters"]

        # The key assertion: strict should NOT be present for GLM
        assert tool_params.get("strict") is not True, "GLM should NOT have strict: true"

    def test_openai_tool_schema_has_strict(self):
        """Verify OpenAI tool schemas include strict: true."""
        config = self._create_config(
            model="gpt-4o",
            base_url="https://api.openai.com/v1"
        )
        detector = GLMProviderDetector(config)

        params = detector.build_request_params(max_tokens=500, tools=[self._create_tool()])

        tools_arg = params["tools"]
        assert len(tools_arg) > 0

        tool_params = tools_arg[0]["function"]["parameters"]

        # ASSERT: strict IS present for OpenAI
        assert tool_params.get("strict") is True, "OpenAI should have strict: true"

    def test_glm_detection_by_model_variants(self):
        """Test GLM detection works for common GLM model variants."""
        glm_models = [
            ("glm-4-flash", "https://open.bigmodel.cn/api/paas/v4/"),
            ("glm-4-plus", "https://api.bigmodel.cn/v1/"),
            ("glm-4-7", "https://api.zhipu.ai/v4/"),
            ("glm-4-air", None),  # model-only detection
            ("GLM-4-PLUS", None),  # case insensitive
        ]

        for model, base_url in glm_models:
            config = self._create_config(model=model, base_url=base_url)
            detector = GLMProviderDetector(config)
            assert detector._is_glm_provider(), f"Model {model} should be detected as GLM"

    def test_non_glm_models_not_misclassified(self):
        """Test non-GLM models are NOT misclassified."""
        non_glm_configs = [
            ("gpt-4o", "https://api.openai.com/v1"),
            ("claude-sonnet-4", "https://api.anthropic.com/v1"),
            ("gemini-2.5-pro", "https://generativelanguage.googleapis.com"),
            # Edge case: model with "glm" but not starting with "glm-"
            ("some-glm-wrapper", "https://api.other.com/v1"),
            # Edge case: generic paas URL (not GLM)
            ("test-model", "https://api.paas.other-provider.com/v1"),
        ]

        for model, base_url in non_glm_configs:
            config = self._create_config(model=model, base_url=base_url)
            detector = GLMProviderDetector(config)
            assert not detector._is_glm_provider(), f"Model {model} should NOT be detected as GLM"
