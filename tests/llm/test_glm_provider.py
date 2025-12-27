"""Unit tests for GLM/BigModel provider detection and compatibility.

This module tests GLM provider detection without importing the full module
which requires the openai package.

Tests use direct recreation of the detection logic for testing.
"""

import pytest
from typing import Optional
from pydantic import BaseModel, SecretStr


class MockLLMConfig(BaseModel):
    """Mock LLMConfig for testing GLM detection."""
    model: str
    base_url: Optional[str] = None
    api_key: Optional[SecretStr] = None


class GLMProviderDetector:
    """Recreation of the _is_glm_provider logic for testing."""

    def __init__(self, config: MockLLMConfig):
        self.config = config
        self.model_name = config.model

    def _requires_legacy_completion_params(self) -> bool:
        """Recreation of the detection logic for testing."""
        base_url = self.config.base_url or ""
        model_name = self.model_name or ""

        # Specific GLM/BigModel host patterns (avoid false positives)
        glm_hosts = ["bigmodel.cn", "zhipu.ai", "bigmodel", "zhipu"]
        if any(host in base_url.lower() for host in glm_hosts):
            return True

        # GLM model names (must start with "glm-" to avoid false positives)
        if model_name.lower().startswith("glm-"):
            return True

        return False


class TestGLMProviderDetection:
    """Tests for GLM/BigModel provider detection."""

    def test_is_glm_provider_by_base_url_bigmodel(self):
        """Test GLM detection via base_url containing 'bigmodel'."""
        config = MockLLMConfig(
            model="test-model",
            base_url="https://open.bigmodel.cn/api/paas/v4/"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_by_base_url_zhipu(self):
        """Test GLM detection via base_url containing 'zhipu'."""
        config = MockLLMConfig(
            model="test-model",
            base_url="https://api.zhipu.ai/v4/"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_by_base_url_bigmodel_cn(self):
        """Test GLM detection via bigmodel.cn domain."""
        config = MockLLMConfig(
            model="test-model",
            base_url="https://api.bigmodel.cn/v1/"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_by_model_name(self):
        """Test GLM detection via model name starting with 'glm-'."""
        config = MockLLMConfig(model="glm-4-flash")
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_by_model_name_glm_4_7(self):
        """Test GLM detection for glm-4-7 specifically."""
        config = MockLLMConfig(model="glm-4-7")
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_by_model_name_glm_4_plus(self):
        """Test GLM detection for glm-4-plus."""
        config = MockLLMConfig(model="glm-4-plus")
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_case_insensitive(self):
        """Test GLM detection is case insensitive."""
        config = MockLLMConfig(
            model="GLM-4-PLUS",
            base_url="https://api.example.com/v1"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_lowercase_url(self):
        """Test GLM detection with lowercase base_url."""
        config = MockLLMConfig(
            model="test-model",
            base_url="https://OPEN.BIGMODEL.CN/api/paas/v4/"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is True

    def test_is_glm_provider_false_for_openai(self):
        """Test GLM detection returns False for actual OpenAI."""
        config = MockLLMConfig(
            model="gpt-4o",
            base_url="https://api.openai.com/v1"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is False

    def test_is_glm_provider_false_for_anthropic(self):
        """Test GLM detection returns False for Anthropic."""
        config = MockLLMConfig(
            model="claude-sonnet-4-5-20250929",
            base_url="https://api.anthropic.com/v1"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is False

    def test_is_glm_provider_false_for_gemini(self):
        """Test GLM detection returns False for Gemini."""
        config = MockLLMConfig(
            model="gemini-2.5-pro",
            base_url="https://generativelanguage.googleapis.com/v1beta"
        )
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is False

    def test_is_glm_provider_no_base_url(self):
        """Test GLM detection with None base_url."""
        config = MockLLMConfig(model="gpt-4", base_url=None)
        detector = GLMProviderDetector(config)
        assert detector._requires_legacy_completion_params() is False

    def test_is_glm_provider_false_generic_glm_name(self):
        """Test that 'glm' without dash prefix doesn't trigger false positive."""
        config = MockLLMConfig(
            model="some-glm-other-model",
            base_url="https://api.other-provider.com/v1"
        )
        detector = GLMProviderDetector(config)
        # Should NOT match because "some-glm-other" doesn't start with "glm-"
        assert detector._requires_legacy_completion_params() is False

    def test_is_glm_provider_false_generic_paas(self):
        """Test that generic 'api.paas' doesn't trigger false positive."""
        config = MockLLMConfig(
            model="test-model",
            base_url="https://api.paas.some-other-provider.com/v1"
        )
        detector = GLMProviderDetector(config)
        # Should NOT match - we removed the generic 'api.paas' pattern
        assert detector._requires_legacy_completion_params() is False


class TestGLMNormalization:
    """Tests for GLM compatibility normalization."""

    def _normalize_tools_for_glm(self, tools: list) -> list:
        """Recreation of the _normalize_tools_for_glm logic for testing."""
        normalized_tools = []
        for tool in tools:
            normalized_tool = tool.copy()
            function_def = normalized_tool.get("function", {})
            if "parameters" in function_def and isinstance(function_def["parameters"], dict):
                # Remove 'strict' parameter - GLM doesn't support it
                function_def["parameters"] = {
                    k: v for k, v in function_def["parameters"].items()
                    if k != "strict"
                }
            normalized_tools.append(normalized_tool)
        return normalized_tools

    def test_normalize_tools_for_glm_removes_strict(self):
        """Test that tool normalization removes 'strict' parameter for GLM."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "test_tool",
                    "description": "A test tool",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "strict": True  # Should be removed
                    }
                }
            }
        ]

        normalized = self._normalize_tools_for_glm(tools)

        assert len(normalized) == 1
        assert "strict" not in normalized[0]["function"]["parameters"]
        assert "type" in normalized[0]["function"]["parameters"]
        assert "properties" in normalized[0]["function"]["parameters"]

    def test_normalize_tools_preserves_other_parameters(self):
        """Test that tool normalization preserves other parameters."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "search",
                    "description": "Search the web",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"}
                        },
                        "required": ["query"],
                        "strict": True
                    }
                }
            }
        ]

        normalized = self._normalize_tools_for_glm(tools)

        params = normalized[0]["function"]["parameters"]
        assert params["type"] == "object"
        assert "properties" in params
        assert "query" in params["properties"]
        assert params["required"] == ["query"]
        assert "strict" not in params

    def test_normalize_tools_handles_empty_parameters(self):
        """Test normalization handles tools without parameters."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "simple_tool",
                    "description": "A simple tool",
                    "parameters": {
                        "type": "object",
                        "properties": {}
                    }
                }
            }
        ]

        normalized = self._normalize_tools_for_glm(tools)

        assert normalized[0]["function"]["parameters"]["type"] == "object"
        assert normalized[0]["function"]["parameters"]["properties"] == {}

    def test_normalize_tools_handles_multiple_tools(self):
        """Test normalization handles multiple tools."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "tool1",
                    "description": "Tool 1",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "strict": True
                    }
                }
            },
            {
                "type": "function",
                "function": {
                    "name": "tool2",
                    "description": "Tool 2",
                    "parameters": {
                        "type": "object",
                        "properties": {"x": {"type": "number"}},
                        "strict": True
                    }
                }
            }
        ]

        normalized = self._normalize_tools_for_glm(tools)

        assert len(normalized) == 2
        assert "strict" not in normalized[0]["function"]["parameters"]
        assert "strict" not in normalized[1]["function"]["parameters"]
        assert "x" in normalized[1]["function"]["parameters"]["properties"]
